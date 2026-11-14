import { z } from 'zod';
import { recordAuditEvent, sanitizeAuditInput } from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import type { PollOptions } from '../client/lightdashV2Client';
import { evaluateSqlGuard } from '../guardrails/sqlAstGuard';
import { evaluateCapability } from '../policy/capabilityPolicy';
import {
    AgentToolError,
    type AgentToolRuntimeOptions,
} from './agentToolTypes';
import {
    TOOL_CAPABILITIES,
    type QueryToolDeps,
    type QueryToolName,
} from './querySchemas';

export type InvokeFn = () => Promise<unknown>;

export const runGuardedQuery = async (
    deps: QueryToolDeps,
    tool: QueryToolName,
    input: { projectUuid: string },
    principal: AgentPrincipal,
    options: AgentToolRuntimeOptions,
    outputSchema: z.ZodType<unknown>,
    invoke: InvokeFn,
    rowCountOf: (result: unknown) => number | null,
): Promise<unknown> => {
    void options;
    const startedAt = Date.now();
    const capability = TOOL_CAPABILITIES[tool];
    const auditBase = {
        capability,
        principal: {
            organizationUuid: principal.organizationUuid,
            userUuid: principal.userUuid,
        },
        projectUuid: input.projectUuid,
        tool,
    };
    const policyVerdict = evaluateCapability(
        principal,
        capability,
        deps.policyContext,
    );
    if (!policyVerdict.allowed) {
        await recordAuditEvent(deps.auditClient, {
            ...auditBase,
            input: sanitizeAuditInput(input),
            policyVerdict: {
                allowed: false,
                reason: policyVerdict.reason,
            },
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
            rowCount: rowCountOf(result),
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
                : 'The request failed before rows could be returned.';
        await recordAuditEvent(deps.auditClient, {
            ...auditBase,
            guardVerdict:
                reason === 'GUARD_DENIED'
                    ? {
                          allowed: false,
                          reason:
                              error instanceof AgentToolError &&
                              error.reason !== null
                                  ? error.reason
                                  : 'DENIED',
                      }
                    : undefined,
            input: sanitizeAuditInput(input),
            latencyMs: Date.now() - startedAt,
            reason,
            verdict: 'deny',
        });
        if (error instanceof AgentToolError) {
            throw error;
        }
        throw new AgentToolError('UPSTREAM_ERROR', message, reason);
    }
};

export const pollOptionsOf = (
    deps: QueryToolDeps,
    options: AgentToolRuntimeOptions,
    input: { page?: number; pageSize?: number },
): PollOptions => ({
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(deps.defaultTimeoutMs !== undefined
        ? { timeoutMs: deps.defaultTimeoutMs }
        : {}),
    ...(input.page !== undefined ? { page: input.page } : {}),
    ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
});

export const enforceSqlExecutionGuard = (
    deps: QueryToolDeps,
    principal: AgentPrincipal,
    sql: string,
    approvalToken: string | undefined,
    limit: number | null | undefined,
): void => {
    const rawSqlPolicy = evaluateCapability(
        principal,
        'raw_sql',
        deps.policyContext,
    );
    if (!rawSqlPolicy.allowed) {
        throw new AgentToolError(
            'POLICY_DENIED',
            'The current user lacks permission for arbitrary SQL execution.',
            rawSqlPolicy.reason,
        );
    }
    const verdict = evaluateSqlGuard(sql, {
        approvalToken: approvalToken ?? null,
        dialect: deps.rawSql.dialect ?? null,
        expectedApprovalToken: deps.rawSql.expectedApprovalToken ?? null,
        maxRows: limit ?? deps.rawSql.maxRows ?? undefined,
        principal: {
            organizationUuid: principal.organizationUuid,
            userUuid: principal.userUuid,
        },
        readOnly: {
            enforced: deps.rawSql.readOnlyEnforced,
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
