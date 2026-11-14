import { z } from 'zod';
import type { LightdashV2Client } from '../client/lightdashV2Client';
import { ABSOLUTE_SQL_GUARD_MAX_ROWS } from '../guardrails/sqlAstGuard';
import {
    agentReadyPageSchema,
    pageSchema,
    pageSizeSchema,
    projectUuidSchema,
    type AgentToolBaseDeps,
} from './agentToolTypes';

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
