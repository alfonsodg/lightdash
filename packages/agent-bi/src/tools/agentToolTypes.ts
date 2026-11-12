// Shared runtime shape for the agent-bi tool slices.
//
// Both tool modules validate input with Zod, gate execution through Issue
// #4's capability policy (plus the SQL guard for raw SQL), and persist one
// audit row per allow AND deny through the injected audit client. Errors
// are white-label: no brand strings, no tokens, no server text.

import { z } from 'zod';
import type { AuditQueryClient } from '../audit/auditLogger';
import type { CatalogVisibility } from '../catalog/catalogIndexer';
import type { CapabilityPolicyContext } from '../policy/capabilityPolicy';

export interface AgentToolRuntimeOptions {
    signal?: AbortSignal | null;
    visibility?: CatalogVisibility | null;
}

export interface AgentToolBaseDeps {
    auditClient: AuditQueryClient;
    policyContext: CapabilityPolicyContext;
}

export type AgentToolErrorCode =
    | 'UNKNOWN_TOOL'
    | 'INVALID_INPUT'
    | 'POLICY_DENIED'
    | 'GUARD_DENIED'
    | 'UPSTREAM_ERROR';

export class AgentToolError extends Error {
    readonly code: AgentToolErrorCode;
    readonly reason: string | null;

    constructor(
        code: AgentToolErrorCode,
        message: string,
        reason: string | null = null,
    ) {
        super(message);
        this.name = 'AgentToolError';
        this.code = code;
        this.reason = reason;
    }
}

// A ready async-query page as returned by every run_* tool. Column values
// stay unknown: the warehouse shapes them, the tool only paginates them.
export const agentReadyPageSchema = z.object({
    columns: z.record(z.string(), z.unknown()),
    nextPage: z.number().nullable(),
    page: z.number(),
    pageSize: z.number(),
    previousPage: z.number().nullable(),
    queryUuid: z.string(),
    rows: z.array(z.record(z.string(), z.unknown())),
    status: z.literal('ready'),
    totalPageCount: z.number().nullable(),
    totalResults: z.number().nullable(),
});

export type AgentReadyPage = z.infer<typeof agentReadyPageSchema>;

export const projectUuidSchema = z.string().uuid();

export const pageSchema = z.number().int().min(1).optional();

export const pageSizeSchema = z.number().int().min(1).max(5000).optional();

// Zod issues rendered as a single truncated line; the agent's own input is
// echoed (never server text), so this stays free of brand strings.
export function formatValidationError(error: z.ZodError): string {
    const details = error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join('.') : 'input';
            return `${String(path)}: ${issue.message}`;
        })
        .join('; ');
    const truncated =
        details.length > 500 ? `${details.slice(0, 500)}…` : details;
    return `Input failed validation: ${truncated}`;
}
