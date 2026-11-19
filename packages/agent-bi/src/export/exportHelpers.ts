import { z } from 'zod';
import {
    recordAuditEvent,
    sanitizeAuditInput,
    type AuditVerdictSource,
} from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { evaluateSqlGuard } from '../guardrails/sqlAstGuard';
import { evaluateCapability } from '../policy/capabilityPolicy';
import {
    AgentToolError,
    type AgentToolRuntimeOptions,
} from '../tools/agentToolTypes';
import type { ChartSqlProvenance } from '../tools/queryTools';
import { buildSchedulerJobStatusPath } from './exportFetch';
import {
    EXPORT_CAPABILITY,
    type ExportDashboardCsvInput,
    type ExportDashboardImageInput,
    type ExportToolDeps,
    type ExportToolName,
} from './exportSchemas';

export type InvokeFn = () => Promise<unknown>;

export const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

// Envelope-aware unwrap: API payloads wrap results in `{ results }`.
export const unwrapResults = (json: unknown): unknown => {
    if (json !== null && typeof json === 'object' && 'results' in json) {
        return (json as { results: unknown }).results;
    }
    return json;
};

const throwIfAborted = (signal: AbortSignal | null | undefined): void => {
    if (signal?.aborted === true) {
        throw new AgentToolError(
            'UPSTREAM_ERROR',
            'The export request was aborted before completion.',
            'ABORTED',
        );
    }
};

const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

// Download-link candidates on a completed job's `details` payload. The
// controller documents `details.url`; alternates keep the tool tolerant.
const FILE_URL_KEYS = ['url', 'fileUrl', 'downloadUrl', 'signedUrl'];

const fileUrlOf = (details: unknown): string | null => {
    const record = asRecord(details);
    for (const key of FILE_URL_KEYS) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate;
        }
    }
    return null;
};

const isPendingStatus = (status: unknown): boolean =>
    status === 'scheduled' || status === 'started';

export const runGuardedExport = async (
    deps: ExportToolDeps,
    tool: ExportToolName,
    input: { projectUuid: string },
    principal: AgentPrincipal,
    _options: AgentToolRuntimeOptions,
    outputSchema: z.ZodType<unknown>,
    invoke: InvokeFn,
): Promise<unknown> => {
    const startedAt = Date.now();
    const auditBase = {
        capability: EXPORT_CAPABILITY,
        principal: {
            organizationUuid: principal.organizationUuid,
            userUuid: principal.userUuid,
        },
        projectUuid: input.projectUuid,
        tool,
    };
    const policyVerdict = evaluateCapability(
        principal,
        EXPORT_CAPABILITY,
        deps.policyContext,
    );
    if (!policyVerdict.allowed) {
        const source: AuditVerdictSource = {
            allowed: false,
            reason: policyVerdict.reason,
        };
        await recordAuditEvent(deps.auditClient, {
            ...auditBase,
            input: sanitizeAuditInput(input),
            policyVerdict: source,
            reason: policyVerdict.message,
            verdict: 'deny',
        });
        throw new AgentToolError(
            'POLICY_DENIED',
            'The current user lacks permission for this action.',
            policyVerdict.reason,
        );
    }
    try {
        const raw = await invoke();
        const result = outputSchema.parse(raw);
        await recordAuditEvent(deps.auditClient, {
            ...auditBase,
            input: sanitizeAuditInput(input),
            latencyMs: Date.now() - startedAt,
            policyVerdict: { allowed: true },
            verdict: 'allow',
        });
        return result;
    } catch (error) {
        if (error instanceof AgentToolError && error.code === 'POLICY_DENIED') {
            throw error;
        }
        const reason =
            error instanceof AgentToolError ? error.code : 'UPSTREAM_ERROR';
        const message =
            error instanceof AgentToolError
                ? error.message
                : 'The request failed before the export could be returned.';
        await recordAuditEvent(deps.auditClient, {
            ...auditBase,
            input: sanitizeAuditInput(input),
            latencyMs: Date.now() - startedAt,
            policyVerdict: { allowed: true },
            reason,
            verdict: 'deny',
        });
        if (error instanceof AgentToolError) {
            throw error;
        }
        throw new AgentToolError('UPSTREAM_ERROR', message, reason);
    }
};

const SCHEDULER_ID_KEYS = [
    'savedChartUuid',
    'dashboardUuid',
    'savedSqlUuid',
    'createdBy',
];

export const withoutResourceIds = (
    body: Record<string, unknown>,
): Record<string, unknown> => {
    const copy = { ...body };
    for (const key of SCHEDULER_ID_KEYS) {
        delete copy[key];
    }
    return copy;
};

// Async job-status loop with deterministic exponential backoff (no
// await-in-loop): delay(n) = min(initial * 2^n, max), no jitter.
export const pollJobToFileUrl = async (
    deps: ExportToolDeps,
    jobId: string,
    timeoutMs: number | undefined,
    options: AgentToolRuntimeOptions,
): Promise<string> => {
    const { poll } = deps;
    const sleep = poll.sleep ?? defaultSleep;
    const now = poll.now ?? Date.now;
    const timeout = timeoutMs ?? poll.timeoutMs;
    const deadline = now() + timeout;
    const step = async (attempt: number): Promise<string> => {
        throwIfAborted(options.signal);
        const results = unwrapResults(
            await deps.exportFetch(
                { method: 'GET', path: buildSchedulerJobStatusPath(jobId) },
                options,
            ),
        );
        const record = asRecord(results);
        const { details, status } = record;
        if (status === 'completed') {
            const fileUrl = fileUrlOf(details);
            if (fileUrl === null) {
                throw new AgentToolError(
                    'UPSTREAM_ERROR',
                    'The export finished without a download link.',
                );
            }
            return fileUrl;
        }
        if (status === 'error') {
            throw new AgentToolError(
                'UPSTREAM_ERROR',
                'The export job failed before a file was ready.',
            );
        }
        if (isPendingStatus(status)) {
            if (attempt + 1 >= poll.maxAttempts || deadline - now() <= 0) {
                throw new AgentToolError(
                    'UPSTREAM_ERROR',
                    'The export did not finish in time.',
                    'TIMEOUT',
                );
            }
            const delay = Math.min(
                poll.initialDelayMs * 2 ** attempt,
                poll.maxDelayMs,
                deadline - now(),
            );
            await sleep(delay);
            throwIfAborted(options.signal);
            return step(attempt + 1);
        }
        throw new AgentToolError(
            'UPSTREAM_ERROR',
            'The export job returned a status the tool could not read.',
        );
    };
    return step(0);
};

export const requireExportDeps = (deps: ExportToolDeps): void => {
    if (!deps.exportFetch) {
        throw new AgentToolError(
            'INVALID_INPUT',
            'An export fetch client is required for export tools.',
        );
    }
    if (!deps.poll) {
        throw new AgentToolError(
            'INVALID_INPUT',
            'Export poll settings are required for export tools.',
        );
    }
};

type DashboardExportInput = ExportDashboardImageInput | ExportDashboardCsvInput;

export const dashboardExportBody = (
    format: 'image' | 'csv',
    input: DashboardExportInput,
): Record<string, unknown> => {
    const body: Record<string, unknown> = { format };
    const options: Record<string, unknown> = {};
    if (format === 'csv') {
        const csvInput = input as ExportDashboardCsvInput;
        if (csvInput.formatted !== undefined) {
            options['formatted'] = csvInput.formatted;
        }
        if (csvInput.limit !== undefined) {
            options['limit'] = csvInput.limit;
        }
    }
    if (format === 'image') {
        const imageInput = input as ExportDashboardImageInput;
        if (imageInput.withPdf !== undefined) {
            options['withPdf'] = imageInput.withPdf;
        }
        if (imageInput.pagePerTab !== undefined) {
            options['pagePerTab'] = imageInput.pagePerTab;
        }
    }
    if (Object.keys(options).length > 0) {
        body['options'] = options;
    }
    if (input.dashboardFilters !== undefined) {
        body['dashboardFilters'] = input.dashboardFilters;
    }
    if (input.parameters !== undefined) {
        body['parameters'] = input.parameters;
    }
    if (input.dateZoomGranularity !== undefined) {
        body['dateZoomGranularity'] = input.dateZoomGranularity;
    }
    if (input.customViewportWidth !== undefined) {
        body['customViewportWidth'] = input.customViewportWidth;
    }
    if (input.selectedTabs !== undefined) {
        body['selectedTabs'] = input.selectedTabs;
    }
    return body;
};

export const jobIdOf = (results: unknown): string => {
    const { jobId: candidate } = asRecord(results);
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
        throw new AgentToolError(
            'UPSTREAM_ERROR',
            'The export did not return a job to poll.',
        );
    }
    return candidate;
};

export const schedulerUuidOf = (results: unknown): string => {
    const { schedulerUuid: candidate } = asRecord(results);
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
        throw new AgentToolError(
            'UPSTREAM_ERROR',
            'The scheduler did not return an id.',
        );
    }
    return candidate;
};

export const enforceExportSqlGuard = (
    deps: ExportToolDeps,
    principal: AgentPrincipal,
    provenance: ChartSqlProvenance | null,
    approvalToken?: string,
): void => {
    if (provenance === null) {
        throw new AgentToolError(
            'GUARD_DENIED',
            'Export target SQL provenance cannot be verified.',
        );
    }
    if (!provenance.isSqlChart) {
        return;
    }
    if (!provenance.sql) {
        throw new AgentToolError(
            'GUARD_DENIED',
            'SQL chart definition could not be inspected before export.',
        );
    }
    const rawSqlPolicy = evaluateCapability(
        principal,
        'raw_sql',
        deps.policyContext,
    );
    if (!rawSqlPolicy.allowed) {
        throw new AgentToolError(
            'POLICY_DENIED',
            'The current user lacks permission to export SQL charts.',
            rawSqlPolicy.reason,
        );
    }
    const verdict = evaluateSqlGuard(provenance.sql, {
        approvalToken: approvalToken ?? null,
        dialect: deps.rawSql?.dialect ?? null,
        expectedApprovalToken: deps.rawSql?.expectedApprovalToken ?? null,
        maxRows: provenance.limit ?? deps.rawSql?.maxRows ?? undefined,
        principal: {
            organizationUuid: principal.organizationUuid,
            userUuid: principal.userUuid,
        },
        readOnly: {
            enforced: deps.rawSql?.readOnlyEnforced ?? false,
        },
    });
    if (!verdict.allowed) {
        throw new AgentToolError(
            'GUARD_DENIED',
            verdict.message,
            verdict.reason,
        );
    }
};

export const assertAuthorizedDelivery = async (
    deps: ExportToolDeps,
    principal: AgentPrincipal,
    projectUuid: string,
    targets: Array<Record<string, unknown>>,
): Promise<void> => {
    if (!deps.authorizeDeliveryTargets) {
        return;
    }
    const verdict = await deps.authorizeDeliveryTargets({
        principal,
        projectUuid,
        targets,
    });
    if (!verdict.allowed) {
        throw new AgentToolError(
            'POLICY_DENIED',
            verdict.reason ??
                'One or more delivery recipients are not authorized.',
        );
    }
};
