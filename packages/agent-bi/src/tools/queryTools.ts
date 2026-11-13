// Governed query tools (Slice C): every execution runs the v2 async
// query APIs through the injected Slice B client — poll-then-fetch, never
// a queued queryUuid treated as a result. Compose pipelines go through
// query-sources, not ad-hoc SQL. Raw SQL additionally passes Issue #4's
// SQL guard and is denied unless the host attests read-only enforcement.

import { z } from 'zod';
import { recordAuditEvent, sanitizeAuditInput } from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import type {
    LightdashV2Client,
    PollOptions,
    V2DashboardChartBody,
    V2MetricQueryBody,
    V2SavedChartBody,
    V2UnderlyingDataBody,
} from '../client/lightdashV2Client';
import {
    ABSOLUTE_SQL_GUARD_MAX_ROWS,
    evaluateSqlGuard,
} from '../guardrails/sqlAstGuard';
import { evaluateCapability } from '../policy/capabilityPolicy';
import {
    agentReadyPageSchema,
    AgentToolError,
    formatValidationError,
    pageSchema,
    pageSizeSchema,
    projectUuidSchema,
    type AgentReadyPage,
    type AgentToolBaseDeps,
    type AgentToolRuntimeOptions,
} from './agentToolTypes';

export { AgentToolError } from './agentToolTypes';

export const QUERY_TOOL_NAMES = [
    'run_metric_query',
    'run_saved_chart',
    'run_underlying_data',
    'run_compose_pipeline',
    'run_sql',
] as const;

export type QueryToolName = (typeof QUERY_TOOL_NAMES)[number];

type QueryCapability = 'metric_query' | 'compose_query' | 'raw_sql';

export const TOOL_CAPABILITIES: Record<QueryToolName, QueryCapability> = {
    run_compose_pipeline: 'compose_query',
    run_metric_query: 'metric_query',
    run_saved_chart: 'metric_query',
    run_sql: 'raw_sql',
    run_underlying_data: 'metric_query',
};

const MAX_NAME_CHARS = 256;
const MAX_SQL_CHARS = 20000;
const DEFAULT_COMPOSE_MAX_QUERIES = 10;
const DEFAULT_METRIC_QUERY_LIMIT = 100;

const nameSchema = z.string().trim().min(1).max(MAX_NAME_CHARS);

const sortsSchema = z
    .array(
        z.object({
            descending: z.boolean().nullable().optional(),
            fieldId: nameSchema,
        }),
    )
    .max(50)
    .optional();

export const runMetricQueryInputSchema = z
    .object({
        dimensions: z.array(nameSchema).max(100).optional(),
        exploreName: nameSchema,
        filters: z.record(z.string(), z.unknown()).optional(),
        limit: z.number().int().min(1).max(5000).nullable().optional(),
        metrics: z.array(nameSchema).max(100).optional(),
        page: pageSchema,
        pageSize: pageSizeSchema,
        projectUuid: projectUuidSchema,
        sorts: sortsSchema,
        timezone: z.string().min(1).max(64).nullable().optional(),
    })
    .refine(
        (input) =>
            (input.dimensions?.length ?? 0) > 0 ||
            (input.metrics?.length ?? 0) > 0,
        { message: 'A metric query needs dimensions or metrics' },
    );

export const runSavedChartInputSchema = z
    .object({
        approvalToken: z.string().min(1).max(1024).optional(),
        chartUuid: z.string().uuid(),
        dashboardFilters: z.record(z.string(), z.unknown()).optional(),
        dashboardUuid: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(5000).nullable().optional(),
        page: pageSchema,
        pageSize: pageSizeSchema,
        projectUuid: projectUuidSchema,
        tileUuid: z.string().min(1).max(MAX_NAME_CHARS).optional(),
        versionUuid: z.string().uuid().optional(),
    })
    .refine(
        (input) =>
            input.dashboardUuid === undefined || input.tileUuid !== undefined,
        {
            message:
                'Dashboard chart execution needs tileUuid alongside dashboardUuid',
        },
    );

export const runUnderlyingDataInputSchema = z.object({
    filters: z.record(z.string(), z.unknown()),
    limit: z.number().int().min(1).max(5000).nullable().optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
    projectUuid: projectUuidSchema,
    sorts: sortsSchema,
    underlyingDataItemId: z.string().min(1).max(MAX_NAME_CHARS).optional(),
    underlyingDataSourceQueryUuid: z.string().uuid(),
});

export const runComposePipelineInputSchema = z.object({
    approvalToken: z.string().min(1).max(1024).optional(),
    invalidateCache: z.boolean().optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
    parameters: z.record(z.string(), z.unknown()).optional(),
    projectUuid: projectUuidSchema,
    queries: z.array(z.record(z.string(), z.unknown())).min(1),
});

export const runSqlInputSchema = z.object({
    approvalToken: z.string().min(1).max(1024).optional(),
    limit: z.number().int().min(1).max(ABSOLUTE_SQL_GUARD_MAX_ROWS).optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
    projectUuid: projectUuidSchema,
    sql: z.string().trim().min(1).max(MAX_SQL_CHARS),
});

export type RunMetricQueryInput = z.infer<typeof runMetricQueryInputSchema>;
export type RunSavedChartInput = z.infer<typeof runSavedChartInputSchema>;
export type RunUnderlyingDataInput = z.infer<
    typeof runUnderlyingDataInputSchema
>;
export type RunComposePipelineInput = z.infer<
    typeof runComposePipelineInputSchema
>;
export type RunSqlInput = z.infer<typeof runSqlInputSchema>;

export const runMetricQueryOutputSchema = agentReadyPageSchema;
export const runSavedChartOutputSchema = agentReadyPageSchema;
export const runUnderlyingDataOutputSchema = agentReadyPageSchema;
export const runSqlOutputSchema = agentReadyPageSchema;

export const runComposePipelineOutputSchema = z.object({
    pages: z.array(agentReadyPageSchema).min(1),
    truncated: z.boolean().optional(),
    warnings: z.array(z.string()).optional(),
});

export type RunComposePipelineOutput = z.infer<
    typeof runComposePipelineOutputSchema
>;

export type QueryToolsClient = Pick<
    LightdashV2Client,
    | 'executeComposeQueries'
    | 'executeDashboardChart'
    | 'executeSavedChart'
    | 'executeUnderlyingData'
    | 'pollQueryToReady'
    | 'runMetricQuery'
    | 'runSqlQuery'
>;

// Host-attested warehouse posture for raw SQL. The guard cannot inspect
// warehouse grants itself, so a missing read-only attestation denies.
export interface RawSqlGuardrails {
    dialect?: string | null;
    expectedApprovalToken?: string | null;
    maxRows?: number;
    readOnlyEnforced: boolean;
}

export interface ChartSqlProvenance {
    isSqlChart: boolean;
    limit?: number | null;
    sql?: string | null;
}

export interface QueryToolDeps extends AgentToolBaseDeps {
    composeMaxQueries?: number;
    defaultTimeoutMs?: number;
    queryClient: QueryToolsClient;
    rawSql: RawSqlGuardrails;
    resolveChartSql?: (
        projectUuid: string,
        chartUuid: string,
    ) => Promise<ChartSqlProvenance | null>;
}

type InvokeFn = () => Promise<unknown>;

const runGuardedQuery = async (
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

const pollOptionsOf = (
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

const enforceSqlExecutionGuard = (
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

export const createQueryTools = (deps: QueryToolDeps) => {
    const guard = (
        tool: QueryToolName,
        input: { projectUuid: string },
        principal: AgentPrincipal,
        options: AgentToolRuntimeOptions,
        outputSchema: z.ZodType<unknown>,
        invoke: InvokeFn,
        rowCountOf: (result: unknown) => number | null = () => null,
    ): Promise<unknown> =>
        runGuardedQuery(
            deps,
            tool,
            input,
            principal,
            options,
            outputSchema,
            invoke,
            rowCountOf,
        );

    const rowsOf = (result: unknown): number | null =>
        (result as AgentReadyPage).rows.length;

    const handlers = {
        run_compose_pipeline: (
            input: RunComposePipelineInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'run_compose_pipeline',
                input,
                principal,
                options,
                runComposePipelineOutputSchema,
                async () => {
                    const maxQueries =
                        deps.composeMaxQueries ?? DEFAULT_COMPOSE_MAX_QUERIES;
                    if (input.queries.length > maxQueries) {
                        throw new AgentToolError(
                            'INVALID_INPUT',
                            `A compose pipeline supports at most ${maxQueries} queries per call.`,
                        );
                    }
                    for (const entry of input.queries) {
                        const rawSqlText =
                            typeof entry.sql === 'string' ? entry.sql : null;
                        const isDuckDbTransform = entry.sourceType === 'duckdb';
                        const isWarehouseSqlSource =
                            !isDuckDbTransform &&
                            (rawSqlText !== null ||
                                entry.type === 'sql' ||
                                entry.type === 'sql_chart' ||
                                entry.sourceType === 'sql');
                        if (isDuckDbTransform) {
                            if (
                                rawSqlText === null ||
                                rawSqlText.trim().length === 0
                            ) {
                                throw new AgentToolError(
                                    'GUARD_DENIED',
                                    'DuckDB compose transform SQL cannot be empty.',
                                );
                            }
                            const verdict = evaluateSqlGuard(rawSqlText, {
                                dialect: 'duckdb',
                                maxRows:
                                    typeof entry.limit === 'number'
                                        ? entry.limit
                                        : deps.rawSql.maxRows ?? undefined,
                                principal: {
                                    organizationUuid:
                                        principal.organizationUuid,
                                    userUuid: principal.userUuid,
                                },
                                readOnly: { enforced: true },
                                requireApproval: false,
                            });
                            if (!verdict.allowed) {
                                throw new AgentToolError(
                                    'GUARD_DENIED',
                                    verdict.message,
                                    verdict.reason,
                                );
                            }
                        } else if (isWarehouseSqlSource) {
                            if (
                                rawSqlText === null ||
                                rawSqlText.trim().length === 0
                            ) {
                                throw new AgentToolError(
                                    'GUARD_DENIED',
                                    'SQL compose source cannot be inspected; denying execution.',
                                );
                            }
                            enforceSqlExecutionGuard(
                                deps,
                                principal,
                                rawSqlText,
                                input.approvalToken,
                                typeof entry.limit === 'number'
                                    ? entry.limit
                                    : undefined,
                            );
                        }
                        if (
                            typeof entry.savedSqlChartUuid === 'string' &&
                            deps.resolveChartSql
                        ) {
                            // eslint-disable-next-line no-await-in-loop
                            const provenance = await deps.resolveChartSql(
                                input.projectUuid,
                                entry.savedSqlChartUuid,
                            );
                            if (
                                provenance === null ||
                                (provenance.isSqlChart && !provenance.sql)
                            ) {
                                throw new AgentToolError(
                                    'GUARD_DENIED',
                                    'SQL compose source provenance cannot be verified.',
                                );
                            }
                            if (provenance.isSqlChart && provenance.sql) {
                                enforceSqlExecutionGuard(
                                    deps,
                                    principal,
                                    provenance.sql,
                                    input.approvalToken,
                                    provenance.limit,
                                );
                            }
                        }
                    }
                    const executed =
                        await deps.queryClient.executeComposeQueries(
                            input.projectUuid,
                            {
                                queries: [...input.queries],
                                ...(input.invalidateCache !== undefined
                                    ? {
                                          invalidateCache:
                                              input.invalidateCache,
                                      }
                                    : {}),
                                ...(input.parameters !== undefined
                                    ? { parameters: input.parameters }
                                    : {}),
                            },
                        );
                    // Statuses converge through the standard results
                    // endpoint: one poll-then-fetch per submitted query.
                    const poll = pollOptionsOf(deps, options, input);
                    const pages = (await Promise.all(
                        executed.queries.map((entry) =>
                            deps.queryClient.pollQueryToReady(
                                input.projectUuid,
                                entry.queryUuid,
                                poll,
                            ),
                        ),
                    )) as AgentReadyPage[];
                    const warnings: string[] = [];
                    pages.forEach((page, index) => {
                        if (
                            page.nextPage !== null ||
                            (page.totalResults !== null &&
                                page.totalResults > page.rows.length)
                        ) {
                            warnings.push(
                                `Compose source ${index + 1} returned ${page.rows.length} of ${page.totalResults ?? 'more'} rows; results may be truncated.`,
                            );
                        }
                    });
                    return {
                        pages,
                        ...(warnings.length > 0
                            ? { truncated: true, warnings }
                            : {}),
                    };
                },
                (result) =>
                    (result as RunComposePipelineOutput).pages.reduce(
                        (total, page) => total + page.rows.length,
                        0,
                    ),
            ) as Promise<RunComposePipelineOutput>,

        run_metric_query: (
            input: RunMetricQueryInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) => {
            const query: V2MetricQueryBody = {
                dimensions: input.dimensions ?? [],
                exploreName: input.exploreName,
                filters: input.filters ?? {},
                limit: input.limit ?? DEFAULT_METRIC_QUERY_LIMIT,
                metrics: input.metrics ?? [],
                sorts: input.sorts ?? [],
                tableCalculations: [],
                ...(input.timezone !== undefined
                    ? { timezone: input.timezone }
                    : {}),
            };
            return guard(
                'run_metric_query',
                input,
                principal,
                options,
                runMetricQueryOutputSchema,
                async () =>
                    deps.queryClient.runMetricQuery(input.projectUuid, query, {
                        ...(input.limit !== undefined
                            ? { limit: input.limit }
                            : {}),
                        ...pollOptionsOf(deps, options, input),
                    }),
                rowsOf,
            ) as Promise<AgentReadyPage>;
        },

        run_saved_chart: (
            input: RunSavedChartInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'run_saved_chart',
                input,
                principal,
                options,
                runSavedChartOutputSchema,
                async () => {
                    if (deps.resolveChartSql) {
                        const provenance = await deps.resolveChartSql(
                            input.projectUuid,
                            input.chartUuid,
                        );
                        if (
                            provenance === null ||
                            (provenance.isSqlChart && !provenance.sql)
                        ) {
                            throw new AgentToolError(
                                'GUARD_DENIED',
                                'Saved chart SQL provenance cannot be verified.',
                            );
                        }
                        if (provenance.isSqlChart && provenance.sql) {
                            enforceSqlExecutionGuard(
                                deps,
                                principal,
                                provenance.sql,
                                input.approvalToken,
                                input.limit ?? provenance.limit,
                            );
                        }
                    }
                    const poll = pollOptionsOf(deps, options, input);
                    if (input.dashboardUuid !== undefined) {
                        const body: V2DashboardChartBody = {
                            chartUuid: input.chartUuid,
                            dashboardFilters: input.dashboardFilters ?? {},
                            dashboardUuid: input.dashboardUuid,
                            tileUuid: input.tileUuid ?? '',
                        };
                        const executed =
                            await deps.queryClient.executeDashboardChart(
                                input.projectUuid,
                                body,
                            );
                        return deps.queryClient.pollQueryToReady(
                            input.projectUuid,
                            executed.queryUuid,
                            poll,
                        );
                    }
                    const body: V2SavedChartBody = {
                        chartUuid: input.chartUuid,
                        ...(input.limit !== undefined
                            ? { limit: input.limit }
                            : {}),
                        ...(input.versionUuid !== undefined
                            ? { versionUuid: input.versionUuid }
                            : {}),
                    };
                    const executed = await deps.queryClient.executeSavedChart(
                        input.projectUuid,
                        body,
                    );
                    return deps.queryClient.pollQueryToReady(
                        input.projectUuid,
                        executed.queryUuid,
                        poll,
                    );
                },
                rowsOf,
            ) as Promise<AgentReadyPage>,

        run_sql: (
            input: RunSqlInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'run_sql',
                input,
                principal,
                options,
                runSqlOutputSchema,
                async () => {
                    const verdict = evaluateSqlGuard(input.sql, {
                        approvalToken: input.approvalToken ?? null,
                        dialect: deps.rawSql.dialect ?? null,
                        expectedApprovalToken:
                            deps.rawSql.expectedApprovalToken ?? null,
                        maxRows:
                            input.limit ?? deps.rawSql.maxRows ?? undefined,
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
                    return deps.queryClient.runSqlQuery(
                        input.projectUuid,
                        {
                            limit: verdict.maxRows,
                            sql: verdict.sanitizedSql,
                        },
                        pollOptionsOf(deps, options, input),
                    );
                },
                rowsOf,
            ) as Promise<AgentReadyPage>,

        run_underlying_data: (
            input: RunUnderlyingDataInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) => {
            const body: V2UnderlyingDataBody = {
                filters: input.filters,
                underlyingDataSourceQueryUuid:
                    input.underlyingDataSourceQueryUuid,
                ...(input.limit !== undefined ? { limit: input.limit } : {}),
                ...(input.sorts !== undefined ? { sorts: input.sorts } : {}),
                ...(input.underlyingDataItemId !== undefined
                    ? { underlyingDataItemId: input.underlyingDataItemId }
                    : {}),
            };
            return guard(
                'run_underlying_data',
                input,
                principal,
                options,
                runUnderlyingDataOutputSchema,
                async () => {
                    const executed =
                        await deps.queryClient.executeUnderlyingData(
                            input.projectUuid,
                            body,
                        );
                    return deps.queryClient.pollQueryToReady(
                        input.projectUuid,
                        executed.queryUuid,
                        pollOptionsOf(deps, options, input),
                    );
                },
                rowsOf,
            ) as Promise<AgentReadyPage>;
        },
    };

    const inputSchemas: Record<QueryToolName, z.ZodType<unknown>> = {
        run_compose_pipeline: runComposePipelineInputSchema,
        run_metric_query: runMetricQueryInputSchema,
        run_saved_chart: runSavedChartInputSchema,
        run_sql: runSqlInputSchema,
        run_underlying_data: runUnderlyingDataInputSchema,
    };

    const executeTool = async (
        toolName: string,
        rawInput: unknown,
        principal: AgentPrincipal,
        options: AgentToolRuntimeOptions = {},
    ): Promise<unknown> => {
        if (
            !QUERY_TOOL_NAMES.includes(toolName as QueryToolName) ||
            !(toolName in handlers)
        ) {
            throw new AgentToolError(
                'UNKNOWN_TOOL',
                `Tool "${toolName}" is not recognized.`,
            );
        }
        const name = toolName as QueryToolName;
        const parsed = inputSchemas[name].safeParse(rawInput);
        if (!parsed.success) {
            throw new AgentToolError(
                'INVALID_INPUT',
                formatValidationError(parsed.error),
            );
        }
        return handlers[name](parsed.data as never, principal, options);
    };

    return { executeTool, handlers, inputSchemas, toolNames: QUERY_TOOL_NAMES };
};
