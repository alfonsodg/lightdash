import { z } from 'zod';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { getAgentBiConfig } from '../config/agentBiConfig';
import {
    projectUuidSchema,
    type AgentToolBaseDeps,
} from '../tools/agentToolTypes';
import type { ChartSqlProvenance, RawSqlGuardrails } from '../tools/queryTools';
import type { ExportFetch } from './exportFetch';

export const EXPORT_TOOL_NAMES = [
    'export_chart_image',
    'export_dashboard_image',
    'export_dashboard_csv',
    'schedule_chart_delivery',
    'schedule_dashboard_delivery',
] as const;

export type ExportToolName = (typeof EXPORT_TOOL_NAMES)[number];

export const EXPORT_CAPABILITY = 'export';

const MAX_NAME_CHARS = 256;
const MAX_TEXT_CHARS = 2000;
const MAX_CRON_CHARS = 128;
const MAX_TIMEZONE_CHARS = 128;
const MAX_SLUG_CHARS = 256;
const MAX_TARGETS = 50;
const MAX_TABS = 50;

const uuidOrSlugSchema = z.string().trim().min(1).max(MAX_SLUG_CHARS);
const filtersSchema = z.record(z.string(), z.unknown());
const timeoutSchema = z.number().int().min(100).max(300_000).optional();

export const exportChartImageInputSchema = z.object({
    chartUuid: z.string().uuid(),
    projectUuid: projectUuidSchema,
});

const dashboardExportBaseSchema = z.object({
    customViewportWidth: z.number().int().min(1).optional(),
    dashboardFilters: filtersSchema.optional(),
    dashboardUuid: z.string().uuid(),
    dateZoomGranularity: z.string().trim().min(1).max(64).optional(),
    parameters: filtersSchema.optional(),
    projectUuid: projectUuidSchema,
    selectedTabs: z.array(z.string().trim().min(1)).max(MAX_TABS).optional(),
    timeoutMs: timeoutSchema,
});

export const exportDashboardImageInputSchema = dashboardExportBaseSchema.extend(
    {
        pagePerTab: z.boolean().optional(),
        withPdf: z.boolean().optional(),
    },
);

export const exportDashboardCsvInputSchema = dashboardExportBaseSchema.extend({
    formatted: z.boolean().optional(),
    limit: z
        .union([z.literal('table'), z.literal('all'), z.number().int().min(1)])
        .optional(),
});

const schedulerTargetSchema = z.record(z.string(), z.unknown());

const schedulerPayloadSchema = z
    .object({
        cron: z.string().trim().min(1).max(MAX_CRON_CHARS),
        customViewportWidth: z.number().int().min(1).optional(),
        filters: filtersSchema.optional(),
        format: z.enum(['csv', 'xlsx', 'image', 'gsheets', 'pdf']).optional(),
        message: z.string().trim().min(1).max(MAX_TEXT_CHARS).optional(),
        name: z.string().trim().min(1).max(MAX_NAME_CHARS),
        notificationFrequency: z.enum(['always', 'once']).optional(),
        options: z.record(z.string(), z.unknown()).optional(),
        parameters: filtersSchema.optional(),
        selectedTabs: z
            .array(z.string().trim().min(1))
            .max(MAX_TABS)
            .optional(),
        targets: z.array(schedulerTargetSchema).min(1).max(MAX_TARGETS),
        timezone: z.string().trim().min(1).max(MAX_TIMEZONE_CHARS).optional(),
        useCachedResults: z.boolean().optional(),
    })
    .catchall(z.unknown());

export const scheduleChartDeliveryInputSchema = z.object({
    chartUuid: z.string().uuid(),
    projectUuid: projectUuidSchema,
    scheduler: schedulerPayloadSchema,
});

export const scheduleDashboardDeliveryInputSchema = z.object({
    dashboardUuidOrSlug: uuidOrSlugSchema,
    projectUuid: projectUuidSchema,
    scheduler: schedulerPayloadSchema,
});

export type ExportChartImageInput = z.infer<typeof exportChartImageInputSchema>;
export type ExportDashboardImageInput = z.infer<
    typeof exportDashboardImageInputSchema
>;
export type ExportDashboardCsvInput = z.infer<
    typeof exportDashboardCsvInputSchema
>;
export type ScheduleChartDeliveryInput = z.infer<
    typeof scheduleChartDeliveryInputSchema
>;
export type ScheduleDashboardDeliveryInput = z.infer<
    typeof scheduleDashboardDeliveryInputSchema
>;

export const exportChartImageOutputSchema = z.object({
    chartUuid: z.string().uuid(),
    imageUrl: z.string().min(1),
});

export const dashboardExportOutputSchema = z.object({
    dashboardUuid: z.string().uuid(),
    fileUrl: z.string().min(1),
    format: z.enum(['image', 'csv']),
    jobId: z.string().min(1),
});

export const scheduleChartDeliveryOutputSchema = z.object({
    chartUuid: z.string().uuid(),
    schedulerUuid: z.string().min(1),
});

export const scheduleDashboardDeliveryOutputSchema = z.object({
    dashboardUuidOrSlug: uuidOrSlugSchema,
    schedulerUuid: z.string().min(1),
});

export type ExportChartImageOutput = z.infer<
    typeof exportChartImageOutputSchema
>;
export type DashboardExportOutput = z.infer<typeof dashboardExportOutputSchema>;
export type ScheduleChartDeliveryOutput = z.infer<
    typeof scheduleChartDeliveryOutputSchema
>;
export type ScheduleDashboardDeliveryOutput = z.infer<
    typeof scheduleDashboardDeliveryOutputSchema
>;

// Poll tuning for the async job-status loop. `sleep`/`now` are seams so
// tests resolve instantly; production uses timers.
export interface ExportPollConfig {
    initialDelayMs: number;
    maxAttempts: number;
    maxDelayMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs: number;
}

export const defaultExportPollConfig = (): ExportPollConfig => {
    const config = getAgentBiConfig();
    return {
        initialDelayMs: config.exportPollInitialDelayMs,
        maxAttempts: config.exportPollMaxAttempts,
        maxDelayMs: config.exportPollMaxDelayMs,
        timeoutMs: config.exportTimeoutMs,
    };
};

export interface ExportToolDeps extends AgentToolBaseDeps {
    authorizeDeliveryTargets?: (input: {
        principal: AgentPrincipal;
        projectUuid: string;
        targets: Array<Record<string, unknown>>;
    }) => Promise<{ allowed: boolean; reason?: string }>;
    exportFetch: ExportFetch;
    poll: ExportPollConfig;
    rawSql?: RawSqlGuardrails;
    resolveChartSql?: (
        projectUuid: string,
        chartUuid: string,
    ) => Promise<ChartSqlProvenance | null>;
    resolveDashboardSqlCharts?: (
        projectUuid: string,
        dashboardUuidOrSlug: string,
    ) => Promise<ChartSqlProvenance[] | null>;
}
