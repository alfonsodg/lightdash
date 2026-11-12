// Content-as-code tools (Slice E): slug upserts, read-back and config
// validation over the canonical `/code/*` routes. Every execution runs
// the Phase-2 capability gate (`content_write`) and persists exactly one
// audit row for allow AND deny through the injected audit client.
//
// Two host-owned seams keep this package dependency-free, following the
// Slice C pattern (catalog search, v2 client):
// - `validators`: Ajv-compiled checks against the canonical schemas in
//   `@lightdash/common` (`getChartAsCodeBranchSchema` for charts and SQL
//   charts, `dashboardAsCodeSchema` for dashboards). The host compiles
//   them; these tools only run them.
// - `renderer`: the `@lightdash/visualization` `renderChart` dry-run. The
//   host draws the config against a one-row synthetic dataset and reports
//   `{ complete: false, reason: 'incompleteConfig' }` when the result is
//   `empty` for that reason. Dashboards never reach the renderer.
// SQL chart upserts additionally run the Phase-2 SQL guard and require a
// human approval token bound to the execution. No deprecated v1 write
// path (`POST /saved`, `PATCH /saved`, `chart-and-results`) is referenced
// anywhere in this module.

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
    formatValidationError,
    projectUuidSchema,
    type AgentToolBaseDeps,
    type AgentToolRuntimeOptions,
} from '../tools/agentToolTypes';
import {
    buildCodeChartItemPath,
    buildCodeChartsPath,
    buildCodeDashboardItemPath,
    buildCodeDashboardsPath,
    buildCodeSqlChartItemPath,
    buildCodeSqlChartsPath,
    type ContentFetch,
} from './contentFetch';

export { AgentToolError } from '../tools/agentToolTypes';

export const CONTENT_TOOL_NAMES = [
    'upsert_chart_as_code',
    'upsert_sql_chart_as_code',
    'upsert_dashboard_as_code',
    'get_chart_or_dashboard',
    'validate_chart_config',
] as const;

export type ContentToolName = (typeof CONTENT_TOOL_NAMES)[number];

export const CONTENT_CAPABILITY = 'content_write';

const MAX_SLUG_CHARS = 256;
const MAX_APPROVAL_TOKEN_CHARS = 1024;

const slugSchema = z.string().trim().min(1).max(MAX_SLUG_CHARS);

const contentBodySchema = z.record(z.string(), z.unknown());

const approvalTokenSchema = z
    .string()
    .min(1)
    .max(MAX_APPROVAL_TOKEN_CHARS)
    .optional();

const forceSchema = z.boolean().optional();

export const upsertChartAsCodeInputSchema = z.object({
    chart: contentBodySchema,
    force: forceSchema,
    projectUuid: projectUuidSchema,
    slug: slugSchema,
});

export const upsertSqlChartAsCodeInputSchema = z.object({
    approvalToken: approvalTokenSchema,
    force: forceSchema,
    projectUuid: projectUuidSchema,
    slug: slugSchema,
    sqlChart: contentBodySchema,
});

export const upsertDashboardAsCodeInputSchema = z.object({
    dashboard: contentBodySchema,
    force: forceSchema,
    projectUuid: projectUuidSchema,
    slug: slugSchema,
});

export const contentKindSchema = z.enum(['chart', 'sql_chart', 'dashboard']);

export const getChartOrDashboardInputSchema = z.object({
    kind: contentKindSchema,
    projectUuid: projectUuidSchema,
    slug: slugSchema,
});

export const validateChartConfigInputSchema = z.object({
    config: contentBodySchema,
    kind: contentKindSchema,
    projectUuid: projectUuidSchema,
});

export type UpsertChartAsCodeInput = z.infer<
    typeof upsertChartAsCodeInputSchema
>;
export type UpsertSqlChartAsCodeInput = z.infer<
    typeof upsertSqlChartAsCodeInputSchema
>;
export type UpsertDashboardAsCodeInput = z.infer<
    typeof upsertDashboardAsCodeInputSchema
>;
export type GetChartOrDashboardInput = z.infer<
    typeof getChartOrDashboardInputSchema
>;
export type ValidateChartConfigInput = z.infer<
    typeof validateChartConfigInputSchema
>;

export const upsertContentOutputSchema = z.object({
    changes: z.record(z.string(), z.unknown()),
    slug: z.string(),
});

export const getChartOrDashboardOutputSchema = z.object({
    item: z.record(z.string(), z.unknown()).nullable(),
    kind: contentKindSchema,
    slug: z.string(),
});

export const validateChartConfigOutputSchema = z.object({
    kind: contentKindSchema,
    valid: z.literal(true),
});

export type UpsertContentOutput = z.infer<typeof upsertContentOutputSchema>;
export type GetChartOrDashboardOutput = z.infer<
    typeof getChartOrDashboardOutputSchema
>;
export type ValidateChartConfigOutput = z.infer<
    typeof validateChartConfigOutputSchema
>;

// Ajv-compiled check against a canonical `@lightdash/common` schema. The
// host compiles it (see `AiAgentContentValidation` in the backend); the
// tool only runs it, so this package stays free of Ajv.
export interface ContentSchemaValidator {
    validate(
        content: unknown,
    ):
        | { valid: boolean; errors: string[] }
        | Promise<{ valid: boolean; errors: string[] }>;
}

export interface ContentValidators {
    chart: ContentSchemaValidator;
    dashboard: ContentSchemaValidator;
    sqlChart: ContentSchemaValidator;
}

export interface ChartDryRunResult {
    complete: boolean;
    reason?: string | null;
}

// Visualization `renderChart` dry-run behind a seam: the host draws the
// config against a one-row synthetic dataset and reports non-complete
// when the result is `empty` (notably `incompleteConfig`). The whole
// content body travels so the host can lift `chartConfig` itself.
export interface ContentChartRenderer {
    dryRun(
        kind: 'chart' | 'sql_chart',
        content: unknown,
    ): ChartDryRunResult | Promise<ChartDryRunResult>;
}

// Host-attested posture for the SQL a chart carries. Mirrors the raw-SQL
// guardrails: the guard cannot inspect warehouse grants, so a missing
// read-only attestation denies, and approval is always required.
export interface ContentSqlApproval {
    dialect?: string | null;
    expectedApprovalToken?: string | null;
    maxRows?: number;
    readOnlyEnforced: boolean;
}

export interface ContentToolDeps extends AgentToolBaseDeps {
    contentFetch: ContentFetch;
    renderer: ContentChartRenderer;
    sqlApproval: ContentSqlApproval;
    validators: ContentValidators;
}

type InvokeFn = () => Promise<unknown>;

interface GuardAuditDetail {
    approvalPresented?: boolean | null;
    rowCount?: number | null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

const asArray = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : [];

// Envelope-aware unwrap: code routes wrap payloads in `{ results }`.
const unwrapResults = (json: unknown): unknown => {
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

const runGuardedContent = async (
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

const KIND_LIST_KEYS: Record<
    'chart' | 'sql_chart' | 'dashboard',
    'charts' | 'sqlCharts' | 'dashboards'
> = {
    chart: 'charts',
    dashboard: 'dashboards',
    sql_chart: 'sqlCharts',
};

const KIND_LIST_PATHS: Record<
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

const assertSchemaValid = async (
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

const withForce = (
    body: Record<string, unknown>,
    force: boolean | undefined,
): Record<string, unknown> => (force === undefined ? body : { ...body, force });

const requireDeps = (deps: ContentToolDeps): void => {
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

export const createContentTools = (deps: ContentToolDeps) => {
    requireDeps(deps);

    const guard = (
        tool: ContentToolName,
        input: { projectUuid: string },
        principal: AgentPrincipal,
        options: AgentToolRuntimeOptions,
        outputSchema: z.ZodType<unknown>,
        invoke: InvokeFn,
        detail: GuardAuditDetail = {},
    ): Promise<unknown> =>
        runGuardedContent(
            deps,
            tool,
            input,
            principal,
            options,
            outputSchema,
            invoke,
            detail,
        );

    const handlers = {
        upsert_chart_as_code: (
            input: UpsertChartAsCodeInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'upsert_chart_as_code',
                input,
                principal,
                options,
                upsertContentOutputSchema,
                async () => {
                    await assertSchemaValid(deps.validators, 'chart', {
                        ...input.chart,
                        slug: input.slug,
                    });
                    const results = unwrapResults(
                        await deps.contentFetch(
                            {
                                body: withForce(
                                    { ...input.chart, slug: input.slug },
                                    input.force,
                                ),
                                method: 'POST',
                                path: buildCodeChartItemPath(
                                    input.projectUuid,
                                    input.slug,
                                ),
                            },
                            options,
                        ),
                    );
                    return { changes: asRecord(results), slug: input.slug };
                },
            ) as Promise<UpsertContentOutput>,

        upsert_sql_chart_as_code: (
            input: UpsertSqlChartAsCodeInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'upsert_sql_chart_as_code',
                input,
                principal,
                options,
                upsertContentOutputSchema,
                async () => {
                    await assertSchemaValid(deps.validators, 'sql_chart', {
                        ...input.sqlChart,
                        slug: input.slug,
                    });
                    const { limit, sql } = input.sqlChart;
                    if (typeof sql !== 'string' || sql.trim().length === 0) {
                        throw new AgentToolError(
                            'INVALID_INPUT',
                            'A SQL chart needs a sql string.',
                        );
                    }
                    const guardVerdict = evaluateSqlGuard(sql, {
                        approvalToken: input.approvalToken ?? null,
                        dialect: deps.sqlApproval.dialect ?? null,
                        expectedApprovalToken:
                            deps.sqlApproval.expectedApprovalToken ?? null,
                        maxRows:
                            typeof limit === 'number'
                                ? limit
                                : (deps.sqlApproval.maxRows ?? undefined),
                        principal: {
                            organizationUuid: principal.organizationUuid,
                            userUuid: principal.userUuid,
                        },
                        readOnly: {
                            enforced: deps.sqlApproval.readOnlyEnforced,
                        },
                    });
                    if (!guardVerdict.allowed) {
                        throw new AgentToolError(
                            'GUARD_DENIED',
                            guardVerdict.message,
                            guardVerdict.reason,
                        );
                    }
                    const results = unwrapResults(
                        await deps.contentFetch(
                            {
                                body: withForce(
                                    { ...input.sqlChart, slug: input.slug },
                                    input.force,
                                ),
                                method: 'POST',
                                path: buildCodeSqlChartItemPath(
                                    input.projectUuid,
                                    input.slug,
                                ),
                            },
                            options,
                        ),
                    );
                    return { changes: asRecord(results), slug: input.slug };
                },
                { approvalPresented: input.approvalToken !== undefined },
            ) as Promise<UpsertContentOutput>,

        upsert_dashboard_as_code: (
            input: UpsertDashboardAsCodeInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'upsert_dashboard_as_code',
                input,
                principal,
                options,
                upsertContentOutputSchema,
                async () => {
                    await assertSchemaValid(deps.validators, 'dashboard', {
                        ...input.dashboard,
                        slug: input.slug,
                    });
                    const results = unwrapResults(
                        await deps.contentFetch(
                            {
                                body: withForce(
                                    { ...input.dashboard, slug: input.slug },
                                    input.force,
                                ),
                                method: 'POST',
                                path: buildCodeDashboardItemPath(
                                    input.projectUuid,
                                    input.slug,
                                ),
                            },
                            options,
                        ),
                    );
                    return { changes: asRecord(results), slug: input.slug };
                },
            ) as Promise<UpsertContentOutput>,

        get_chart_or_dashboard: (
            input: GetChartOrDashboardInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) => {
            const listKey =
                KIND_LIST_KEYS[input.kind] ?? KIND_LIST_KEYS['dashboard'];
            const listPathBuilder =
                KIND_LIST_PATHS[input.kind] ?? KIND_LIST_PATHS['dashboard'];
            const path = listPathBuilder(input.projectUuid);
            let found: Record<string, unknown> | null = null;
            return guard(
                'get_chart_or_dashboard',
                input,
                principal,
                options,
                getChartOrDashboardOutputSchema,
                async () => {
                    const results = unwrapResults(
                        await deps.contentFetch(
                            {
                                method: 'GET',
                                path,
                                query: { ids: input.slug },
                            },
                            options,
                        ),
                    );
                    const items = asArray(asRecord(results)[listKey])
                        .map((entry) => asRecord(entry))
                        .filter((entry) => typeof entry['slug'] === 'string');
                    const match =
                        items.find((entry) => entry['slug'] === input.slug) ??
                        null;
                    found = match;
                    if (match === null) {
                        throw new AgentToolError(
                            'UPSTREAM_ERROR',
                            `No ${input.kind} found for slug "${input.slug}".`,
                        );
                    }
                    return { item: match, kind: input.kind, slug: input.slug };
                },
                {
                    get rowCount() {
                        return found !== null ? 1 : 0;
                    },
                },
            ) as Promise<GetChartOrDashboardOutput>;
        },

        validate_chart_config: (
            input: ValidateChartConfigInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'validate_chart_config',
                input,
                principal,
                options,
                validateChartConfigOutputSchema,
                async () => {
                    await assertSchemaValid(
                        deps.validators,
                        input.kind,
                        input.config,
                    );
                    if (input.kind === 'chart' || input.kind === 'sql_chart') {
                        const dryRun = await deps.renderer.dryRun(
                            input.kind,
                            input.config,
                        );
                        if (!dryRun.complete) {
                            throw new AgentToolError(
                                'INVALID_INPUT',
                                `The chart config cannot draw (${dryRun.reason ?? 'unknown reason'}).`,
                            );
                        }
                    }
                    return { kind: input.kind, valid: true as const };
                },
            ) as Promise<ValidateChartConfigOutput>,
    };

    const inputSchemas: Record<ContentToolName, z.ZodType<unknown>> = {
        get_chart_or_dashboard: getChartOrDashboardInputSchema,
        upsert_chart_as_code: upsertChartAsCodeInputSchema,
        upsert_dashboard_as_code: upsertDashboardAsCodeInputSchema,
        upsert_sql_chart_as_code: upsertSqlChartAsCodeInputSchema,
        validate_chart_config: validateChartConfigInputSchema,
    };

    const executeTool = async (
        toolName: string,
        rawInput: unknown,
        principal: AgentPrincipal,
        options: AgentToolRuntimeOptions = {},
    ): Promise<unknown> => {
        if (
            !CONTENT_TOOL_NAMES.includes(toolName as ContentToolName) ||
            !(toolName in handlers)
        ) {
            throw new AgentToolError(
                'UNKNOWN_TOOL',
                `Tool "${toolName}" is not recognized.`,
            );
        }
        const name = toolName as ContentToolName;
        const parsed = inputSchemas[name].safeParse(rawInput);
        if (!parsed.success) {
            throw new AgentToolError(
                'INVALID_INPUT',
                formatValidationError(parsed.error),
            );
        }
        return handlers[name](parsed.data as never, principal, options);
    };

    return {
        executeTool,
        handlers,
        inputSchemas,
        toolNames: CONTENT_TOOL_NAMES,
    };
};
