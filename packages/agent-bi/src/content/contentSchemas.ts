import { z } from 'zod';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import {
    projectUuidSchema,
    type AgentToolBaseDeps,
} from '../tools/agentToolTypes';
import type { ContentFetch } from './contentFetch';

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

export interface ContentChartRenderer {
    dryRun(
        kind: 'chart' | 'sql_chart',
        content: unknown,
    ): ChartDryRunResult | Promise<ChartDryRunResult>;
}

export interface ContentSqlApproval {
    dialect?: string | null;
    expectedApprovalToken?: string | null;
    maxRows?: number;
    readOnlyEnforced: boolean;
}

export interface SpaceAccessVerdict {
    exists: boolean;
    isPublic: boolean;
    writable: boolean;
}

export interface ContentToolDeps extends AgentToolBaseDeps {
    contentFetch: ContentFetch;
    renderer: ContentChartRenderer;
    sqlApproval: ContentSqlApproval;
    validators: ContentValidators;
    verifySpaceAccess?: (
        projectUuid: string,
        spaceSlug: string,
        principal: AgentPrincipal,
    ) => Promise<SpaceAccessVerdict>;
}
