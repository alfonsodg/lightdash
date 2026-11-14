import { z } from 'zod';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { getAgentBiConfig } from '../config/agentBiConfig';
import type {
    V2DashboardChartBody,
    V2MetricQueryBody,
    V2SavedChartBody,
    V2UnderlyingDataBody,
} from '../client/lightdashV2Client';
import { evaluateSqlGuard } from '../guardrails/sqlAstGuard';
import {
    AgentToolError,
    formatValidationError,
    type AgentReadyPage,
    type AgentToolRuntimeOptions,
} from './agentToolTypes';
import {
    enforceSqlExecutionGuard,
    pollOptionsOf,
    runGuardedQuery,
    type InvokeFn,
} from './queryHelpers';
import {
    QUERY_TOOL_NAMES,
    runComposePipelineInputSchema,
    runComposePipelineOutputSchema,
    runMetricQueryInputSchema,
    runMetricQueryOutputSchema,
    runSavedChartInputSchema,
    runSavedChartOutputSchema,
    runSqlInputSchema,
    runSqlOutputSchema,
    runUnderlyingDataInputSchema,
    runUnderlyingDataOutputSchema,
    type QueryToolDeps,
    type QueryToolName,
    type RunComposePipelineInput,
    type RunComposePipelineOutput,
    type RunMetricQueryInput,
    type RunSavedChartInput,
    type RunSqlInput,
    type RunUnderlyingDataInput,
} from './querySchemas';

export { AgentToolError } from './agentToolTypes';
export {
    QUERY_TOOL_NAMES,
    TOOL_CAPABILITIES,
    runComposePipelineInputSchema,
    runComposePipelineOutputSchema,
    runMetricQueryInputSchema,
    runMetricQueryOutputSchema,
    runSavedChartInputSchema,
    runSavedChartOutputSchema,
    runSqlInputSchema,
    runSqlOutputSchema,
    runUnderlyingDataInputSchema,
    runUnderlyingDataOutputSchema,
    type ChartSqlProvenance,
    type QueryToolDeps,
    type QueryToolName,
    type QueryToolsClient,
    type RawSqlGuardrails,
    type RunComposePipelineInput,
    type RunComposePipelineOutput,
    type RunMetricQueryInput,
    type RunSavedChartInput,
    type RunSqlInput,
    type RunUnderlyingDataInput,
} from './querySchemas';

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
                        deps.composeMaxQueries ??
                        getAgentBiConfig().composeMaxQueries;
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
                limit: input.limit ?? getAgentBiConfig().metricQueryLimit,
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
