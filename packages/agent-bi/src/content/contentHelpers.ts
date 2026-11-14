import { z } from 'zod';
import {
    recordAuditEvent,
    sanitizeAuditInput,
    type AuditVerdictSource,
} from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { evaluateCapability } from '../policy/capabilityPolicy';
import {
    AgentToolError,
    type AgentToolRuntimeOptions,
} from '../tools/agentToolTypes';
import {
    buildCodeChartsPath,
    buildCodeDashboardsPath,
    buildCodeSqlChartsPath,
} from './contentFetch';
import {
    CONTENT_CAPABILITY,
    type ContentSchemaValidator,
    type ContentToolDeps,
    type ContentToolName,
    type ContentValidators,
} from './contentSchemas';

export type InvokeFn = () => Promise<unknown>;

export interface GuardAuditDetail {
    approvalPresented?: boolean | null;
    rowCount?: number | null;
}

export const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

export const asArray = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : [];

export const unwrapResults = (json: unknown): unknown => {
    if (json !== null && typeof json === 'object' && 'results' in json) {
        return (json as { results: unknown }).results;
    }
    return json;
};

const formatSchemaErrors = (errors: readonly string[]): string => {
    const details = errors
        .map((error) => error.trim())
        .filter((error) => error.length > 0)
        .join('; ');
    const truncated =
        details.length > 500 ? `${details.slice(0, 500)}…` : details;
    return `Content failed validation: ${truncated}`;
};

export const runGuardedContent = async (
    deps: ContentToolDeps,
    tool: ContentToolName,
    input: { projectUuid: string },
    principal: AgentPrincipal,
    options: AgentToolRuntimeOptions,
    outputSchema: z.ZodType<unknown>,
    invoke: InvokeFn,
    detail: GuardAuditDetail = {},
): Promise<unknown> => {
    void options;
    const startedAt = Date.now();
    const auditBase = {
        approvalPresented: detail.approvalPresented ?? null,
        capability: CONTENT_CAPABILITY,
        principal: {
            organizationUuid: principal.organizationUuid,
            userUuid: principal.userUuid,
        },
        projectUuid: input.projectUuid,
        tool,
    };
    const policyVerdict = evaluateCapability(
        principal,
        CONTENT_CAPABILITY,
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
            ...(detail.rowCount !== undefined && detail.rowCount !== null
                ? { rowCount: detail.rowCount }
                : {}),
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
                : 'The request failed before content could be returned.';
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

export const KIND_LIST_KEYS: Record<
    'chart' | 'sql_chart' | 'dashboard',
    'charts' | 'sqlCharts' | 'dashboards'
> = {
    chart: 'charts',
    dashboard: 'dashboards',
    sql_chart: 'sqlCharts',
};

export const KIND_LIST_PATHS: Record<
    'chart' | 'sql_chart' | 'dashboard',
    (projectUuid: string) => string
> = {
    chart: buildCodeChartsPath,
    dashboard: buildCodeDashboardsPath,
    sql_chart: buildCodeSqlChartsPath,
};

const KIND_VALIDATORS: Record<
    'chart' | 'sql_chart' | 'dashboard',
    'chart' | 'sqlChart' | 'dashboard'
> = {
    chart: 'chart',
    dashboard: 'dashboard',
    sql_chart: 'sqlChart',
};

const validatorFor = (
    validators: ContentValidators,
    kind: 'chart' | 'sql_chart' | 'dashboard',
): ContentSchemaValidator => validators[KIND_VALIDATORS[kind]];

export const assertSchemaValid = async (
    validators: ContentValidators,
    kind: 'chart' | 'sql_chart' | 'dashboard',
    content: unknown,
): Promise<void> => {
    const verdict = await validatorFor(validators, kind).validate(content);
    if (!verdict.valid) {
        throw new AgentToolError(
            'INVALID_INPUT',
            formatSchemaErrors(verdict.errors),
        );
    }
};

export const withForce = (
    body: Record<string, unknown>,
    force: boolean | undefined,
): Record<string, unknown> => (force === undefined ? body : { ...body, force });

export const stripNullDashboardSlug = (
    body: Record<string, unknown>,
): Record<string, unknown> => {
    if (body.dashboardSlug !== null) return body;
    const { dashboardSlug: _omitted, ...rest } = body;
    return rest;
};

export const assertSafeSpaceTarget = async (
    deps: ContentToolDeps,
    projectUuid: string,
    payload: Record<string, unknown>,
    principal: AgentPrincipal,
): Promise<void> => {
    if ('access' in payload && payload.access !== undefined) {
        throw new AgentToolError(
            'POLICY_DENIED',
            'Access policy changes are not permitted by the extension.',
        );
    }
    const { spaceSlug } = payload;
    if (
        deps.verifySpaceAccess &&
        typeof spaceSlug === 'string' &&
        spaceSlug.trim().length > 0
    ) {
        const verdict = await deps.verifySpaceAccess(
            projectUuid,
            spaceSlug,
            principal,
        );
        if (!verdict.exists) {
            throw new AgentToolError(
                'POLICY_DENIED',
                'Target space does not exist; implicit space creation is not permitted.',
            );
        }
        if (!verdict.writable) {
            throw new AgentToolError(
                'POLICY_DENIED',
                'The current user lacks write permission on the target space.',
            );
        }
    }
};

export const requireContentDeps = (deps: ContentToolDeps): void => {
    if (!deps.contentFetch) {
        throw new AgentToolError(
            'INVALID_INPUT',
            'A content fetch client is required for content tools.',
        );
    }
    if (!deps.validators) {
        throw new AgentToolError(
            'INVALID_INPUT',
            'Content schema validators are required for content tools.',
        );
    }
    if (!deps.renderer) {
        throw new AgentToolError(
            'INVALID_INPUT',
            'A chart renderer is required for content tools.',
        );
    }
    if (!deps.sqlApproval) {
        throw new AgentToolError(
            'INVALID_INPUT',
            'SQL approval guardrails are required for content tools.',
        );
    }
};
