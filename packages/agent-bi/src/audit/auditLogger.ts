// Audit logger for agent activity (Slice D).
//
// Every policy allow AND deny is persisted as exactly one row in
// `agent_ext.audit_logs` through an injected `query` function, so this
// package stays driver-free (same pattern as `src/db/migrate.ts`). The
// table has no dedicated user/org/project/capability columns, so those
// travel in `metadata`; only indexed scalar columns carry the tool and
// project reference. Secrets never reach storage: inputs are scrubbed
// before the insert is built.
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { AGENT_EXT_SCHEMA, resolveSchemaName } from '../db/schema';

// Minimal client surface so the writer works with any driver without
// adding a dependency to this package.
export interface AuditQueryClient {
    query(text: string, params?: unknown[]): Promise<unknown>;
}

export type AuditVerdict = 'allow' | 'deny';

// Structural verdict sources: the policy slice (capability gate) and the
// guardrail slice (SQL gate) plug in here without new imports. A deny in
// either source is recorded; the writer never re-decides.
export interface AuditVerdictSource {
    allowed: boolean;
    reason?: string | null;
}

export interface RecordAuditEventInput {
    principal: Pick<AgentPrincipal, 'userUuid' | 'organizationUuid'>;
    projectUuid?: string | null;
    capability: string;
    tool: string;
    verdict: AuditVerdict;
    policyVerdict?: AuditVerdictSource | null;
    guardVerdict?: AuditVerdictSource | null;
    reason?: string | null;
    approvalPresented?: boolean | null;
    input?: unknown;
    rowCount?: number | null;
    latencyMs?: number | null;
}

export class AuditLogError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AuditLogError';
    }
}

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REDACTED = '[REDACTED]';

// Field names whose values are always secrets, whatever they contain.
const SENSITIVE_KEY_PATTERN =
    /(password|passwd|secret|token|api[_-]?key|authorization|bearer|credential|private[_-]?key|client[_-]?secret|session[_-]?token|cookie|access[_-]?key|refresh[_-]?token)/i;

// Token-shaped values redacted even under innocent keys. Covers the
// host PAT (`ldpat_`) and service-account (`ldsvc_`) prefixes plus
// common bearer/store patterns. The full value is dropped: a prefix is
// enough to identify the kind without keeping searchable secret text.
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
    /^ldpat_[A-Za-z0-9_-]+$/,
    /^ldsvc_[A-Za-z0-9_-]+$/,
    /^(Bearer|Basic|Token)\s+\S+/i,
    /^sk-(live|test)-[A-Za-z0-9_-]+$/,
    /^xox[bpas]-[A-Za-z0-9-]+$/,
    /^gh[pousr]_[A-Za-z0-9_]+$/,
    /^tok-[A-Za-z0-9_-]+$/,
];

const MAX_STRING_CHARS = 2000;
const MAX_METADATA_CHARS = 8000;
const MAX_IDENTIFIER_CHARS = 200;
const MAX_DEPTH = 10;

const truncate = (value: string, max: number): string =>
    value.length > max ? `${value.slice(0, max)}…` : value;

const isSensitiveKey = (key: string): boolean =>
    SENSITIVE_KEY_PATTERN.test(key);

const isSensitiveValue = (value: string): boolean =>
    SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value.trim()));

function sanitizeValue(
    value: unknown,
    depth: number,
    seen: WeakSet<object>,
): unknown {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'string') {
        if (isSensitiveValue(value)) {
            return REDACTED;
        }
        return truncate(value, MAX_STRING_CHARS);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== 'object' || depth >= MAX_DEPTH) {
        return typeof value === 'object' ? REDACTED : null;
    }
    const container = value as Record<string, unknown>;
    if (seen.has(container)) {
        return REDACTED;
    }
    seen.add(container);
    if (Array.isArray(container)) {
        return container.map((entry) => sanitizeValue(entry, depth + 1, seen));
    }
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(container)) {
        cleaned[key] = isSensitiveKey(key)
            ? REDACTED
            : sanitizeValue(entry, depth + 1, seen);
    }
    return cleaned;
}

// Public so hosts can preview what would be stored. `undefined` (no
// input given) becomes `null` so the metadata field is always present.
export function sanitizeAuditInput(value: unknown): unknown {
    if (value === undefined) {
        return null;
    }
    return sanitizeValue(value, 0, new WeakSet());
}

const requireNonEmpty = (field: string, value: string): string => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new AuditLogError(
            `Audit event field "${field}" must not be empty.`,
        );
    }
    return truncate(trimmed, MAX_IDENTIFIER_CHARS);
};

const requireUuid = (field: string, value: string): string => {
    const trimmed = value.trim();
    if (!UUID_PATTERN.test(trimmed)) {
        throw new AuditLogError(
            `Audit event field "${field}" must be a valid identifier.`,
        );
    }
    return trimmed;
};

const requireOptionalUuid = (
    field: string,
    value: string | null | undefined,
): string | null => {
    if (value === null || value === undefined || value.trim().length === 0) {
        return null;
    }
    return requireUuid(field, value);
};

const requireOptionalCount = (
    field: string,
    value: number | null | undefined,
    integer: boolean,
): number | null => {
    if (value === null || value === undefined) {
        return null;
    }
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        (integer && !Number.isInteger(value))
    ) {
        throw new AuditLogError(
            `Audit event field "${field}" must be a non-negative ${integer ? 'integer' : 'number'}.`,
        );
    }
    return value;
};

const denyReasonOf = (
    source: AuditVerdictSource | null | undefined,
): string | null => {
    if (source && !source.allowed) {
        const reason = source.reason?.trim();
        return reason && reason.length > 0 ? reason : 'DENIED';
    }
    return null;
};

export interface AuditInsert {
    text: string;
    params: [string, string, string, string | null, string];
    metadata: Record<string, unknown>;
}

// Builds (but does not run) the insert so hosts and tests can inspect
// the exact row. Validation here means storage failures stay distinct
// from attribution failures.
export function buildAuditInsert(
    event: RecordAuditEventInput,
    schema: string = AGENT_EXT_SCHEMA,
): AuditInsert {
    const table = resolveSchemaName(schema);
    const userUuid = requireUuid(
        'userUuid',
        String(event.principal?.userUuid ?? ''),
    );
    const organizationUuid = requireNonEmpty(
        'organizationUuid',
        String(event.principal?.organizationUuid ?? ''),
    );
    const projectUuid = requireOptionalUuid('projectUuid', event.projectUuid);
    const capability = requireNonEmpty(
        'capability',
        String(event.capability ?? ''),
    );
    const tool = requireNonEmpty('tool', String(event.tool ?? ''));
    if (event.verdict !== 'allow' && event.verdict !== 'deny') {
        throw new AuditLogError(
            'Audit event verdict must be "allow" or "deny".',
        );
    }
    const rowCount = requireOptionalCount('rowCount', event.rowCount, true);
    const latencyMs = requireOptionalCount('latencyMs', event.latencyMs, false);
    const explicitReason = event.reason?.trim();
    const policyReason = denyReasonOf(event.policyVerdict);
    const guardReason = denyReasonOf(event.guardVerdict);
    const reason =
        explicitReason && explicitReason.length > 0
            ? truncate(explicitReason, MAX_STRING_CHARS)
            : (policyReason ?? guardReason);
    let approvalPresented: boolean | null = null;
    if (event.approvalPresented === true) {
        approvalPresented = true;
    } else if (event.approvalPresented === false) {
        approvalPresented = false;
    }
    const action = `agent.${capability}.${event.verdict}`;
    const metadata: Record<string, unknown> = {
        approvalPresented,
        capability,
        guardReason,
        input: sanitizeAuditInput(event.input),
        latencyMs,
        organizationUuid,
        policyReason,
        projectUuid,
        reason,
        rowCount,
        tool,
        userUuid,
        verdict: event.verdict,
    };
    let serialized = JSON.stringify(metadata);
    if (serialized.length > MAX_METADATA_CHARS) {
        const note = '…[TRUNCATED]';
        serialized = `${serialized.slice(0, MAX_METADATA_CHARS - note.length)}${note}`;
    }
    return {
        metadata,
        params: [userUuid, action, tool, projectUuid, serialized],
        text: `INSERT INTO "${table}"."audit_logs" (actor_uuid, action, entity_type, entity_uuid, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    };
}

// Persists exactly one row for both allow and deny verdicts. Storage
// errors propagate so a missing audit trail is loud, never silent.
export async function recordAuditEvent(
    client: AuditQueryClient,
    event: RecordAuditEventInput,
    schema?: string,
): Promise<void> {
    const insert = buildAuditInsert(event, schema);
    await client.query(insert.text, [...insert.params]);
}
