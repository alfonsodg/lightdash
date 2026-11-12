// Export tools (Slice F): chart image export, async dashboard exports with
// job polling to completion, and chart/dashboard scheduled deliveries.
//
// Every execution runs the Phase-2 capability gate (`export`) and persists
// exactly one audit row for allow AND deny through the injected audit
// client. Async exports schedule a job and poll the canonical v1
// job-status route until `completed`, then hand back the download link
// from `details`. No deprecated v1 write path (`POST /saved`,
// `PATCH /saved`) is referenced anywhere in this module.

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
    formatValidationError,
    projectUuidSchema,
    type AgentToolBaseDeps,
    type AgentToolRuntimeOptions,
} from '../tools/agentToolTypes';
import {
    buildDashboardExportsPath,
    buildDashboardSchedulersPath,
    buildSavedChartExportPath,
    buildSavedChartSchedulersPath,
    buildSchedulerJobStatusPath,
    type ExportFetch,
} from './exportFetch';

export { AgentToolError } from '../tools/agentToolTypes';

export const EXPORT_TOOL_NAMES = [
    'export_chart_image',
    'export_dashboard_image',
    'export_dashboard_csv',
    'schedule_chart_delivery',
    'schedule_dashboard_delivery',
] as const;

export type ExportToolName = (typeof EXPORT_TOOL_NAMES)[number];

const EXPORT_CAPABILITY = 'export';

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

export const defaultExportPollConfig = (): ExportPollConfig => ({
    initialDelayMs: 500,
    maxAttempts: 30,
    maxDelayMs: 5_000,
    timeoutMs: 60_000,
});

export interface ExportToolDeps extends AgentToolBaseDeps {
    exportFetch: ExportFetch;
    poll: ExportPollConfig;
}

type InvokeFn = () => Promise<unknown>;

const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

// Envelope-aware unwrap: API payloads wrap results in `{ results }`.
const unwrapResults = (json: unknown): unknown => {
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

const runGuardedExport = async (
    deps: ExportToolDeps,
    tool: ExportToolName,
    input: { projectUuid: string },
    principal: AgentPrincipal,
    options: AgentToolRuntimeOptions,
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

// Resource uuid keys never travel inside a scheduler create body: the
// target is already addressed by the route path.
const SCHEDULER_ID_KEYS = [
    'savedChartUuid',
    'dashboardUuid',
    'savedSqlUuid',
    'createdBy',
];

const withoutResourceIds = (
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
const pollJobToFileUrl = async (
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
            if (attempt + 1 >= poll.maxAttempts) {
                throw new AgentToolError(
                    'UPSTREAM_ERROR',
                    'The export did not finish in time.',
                    'TIMEOUT',
                );
            }
            if (deadline - now() <= 0) {
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

const requireDeps = (deps: ExportToolDeps): void => {
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

const dashboardExportBody = (
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

const jobIdOf = (results: unknown): string => {
    const { jobId: candidate } = asRecord(results);
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
        throw new AgentToolError(
            'UPSTREAM_ERROR',
            'The export did not return a job to poll.',
        );
    }
    return candidate;
};

const schedulerUuidOf = (results: unknown): string => {
    const { schedulerUuid: candidate } = asRecord(results);
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
        throw new AgentToolError(
            'UPSTREAM_ERROR',
            'The scheduler did not return an id.',
        );
    }
    return candidate;
};

export const createExportTools = (deps: ExportToolDeps) => {
    requireDeps(deps);

    const guard = (
        tool: ExportToolName,
        input: { projectUuid: string },
        principal: AgentPrincipal,
        options: AgentToolRuntimeOptions,
        outputSchema: z.ZodType<unknown>,
        invoke: InvokeFn,
    ): Promise<unknown> =>
        runGuardedExport(
            deps,
            tool,
            input,
            principal,
            options,
            outputSchema,
            invoke,
        );

    const scheduleExport = async (
        format: 'image' | 'csv',
        input: DashboardExportInput,
        options: AgentToolRuntimeOptions,
    ): Promise<DashboardExportOutput> => {
        const scheduled = unwrapResults(
            await deps.exportFetch(
                {
                    body: dashboardExportBody(format, input),
                    method: 'POST',
                    path: buildDashboardExportsPath(input.dashboardUuid),
                },
                options,
            ),
        );
        const jobId = jobIdOf(scheduled);
        const fileUrl = await pollJobToFileUrl(
            deps,
            jobId,
            input.timeoutMs,
            options,
        );
        return {
            dashboardUuid: input.dashboardUuid,
            fileUrl,
            format,
            jobId,
        };
    };

    const handlers = {
        export_chart_image: (
            input: ExportChartImageInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'export_chart_image',
                input,
                principal,
                options,
                exportChartImageOutputSchema,
                async () => {
                    const results = unwrapResults(
                        await deps.exportFetch(
                            {
                                method: 'POST',
                                path: buildSavedChartExportPath(
                                    input.chartUuid,
                                ),
                                query: { projectUuid: input.projectUuid },
                            },
                            options,
                        ),
                    );
                    const { imageUrl } = asRecord(results);
                    const direct =
                        typeof results === 'string' ? results : imageUrl;
                    if (typeof direct !== 'string' || direct.length === 0) {
                        throw new AgentToolError(
                            'UPSTREAM_ERROR',
                            'The chart export did not return an image.',
                        );
                    }
                    return { chartUuid: input.chartUuid, imageUrl: direct };
                },
            ) as Promise<ExportChartImageOutput>,

        export_dashboard_image: (
            input: ExportDashboardImageInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'export_dashboard_image',
                input,
                principal,
                options,
                dashboardExportOutputSchema,
                async () => scheduleExport('image', input, options),
            ) as Promise<DashboardExportOutput>,

        export_dashboard_csv: (
            input: ExportDashboardCsvInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'export_dashboard_csv',
                input,
                principal,
                options,
                dashboardExportOutputSchema,
                async () => scheduleExport('csv', input, options),
            ) as Promise<DashboardExportOutput>,

        schedule_chart_delivery: (
            input: ScheduleChartDeliveryInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'schedule_chart_delivery',
                input,
                principal,
                options,
                scheduleChartDeliveryOutputSchema,
                async () => {
                    const results = unwrapResults(
                        await deps.exportFetch(
                            {
                                body: withoutResourceIds({
                                    ...(input.scheduler as Record<
                                        string,
                                        unknown
                                    >),
                                }),
                                method: 'POST',
                                path: buildSavedChartSchedulersPath(
                                    input.chartUuid,
                                ),
                            },
                            options,
                        ),
                    );
                    return {
                        chartUuid: input.chartUuid,
                        schedulerUuid: schedulerUuidOf(results),
                    };
                },
            ) as Promise<ScheduleChartDeliveryOutput>,

        schedule_dashboard_delivery: (
            input: ScheduleDashboardDeliveryInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'schedule_dashboard_delivery',
                input,
                principal,
                options,
                scheduleDashboardDeliveryOutputSchema,
                async () => {
                    const results = unwrapResults(
                        await deps.exportFetch(
                            {
                                body: withoutResourceIds({
                                    ...(input.scheduler as Record<
                                        string,
                                        unknown
                                    >),
                                }),
                                method: 'POST',
                                path: buildDashboardSchedulersPath(
                                    input.dashboardUuidOrSlug,
                                ),
                            },
                            options,
                        ),
                    );
                    return {
                        dashboardUuidOrSlug: input.dashboardUuidOrSlug,
                        schedulerUuid: schedulerUuidOf(results),
                    };
                },
            ) as Promise<ScheduleDashboardDeliveryOutput>,
    };

    const inputSchemas: Record<ExportToolName, z.ZodType<unknown>> = {
        export_chart_image: exportChartImageInputSchema,
        export_dashboard_csv: exportDashboardCsvInputSchema,
        export_dashboard_image: exportDashboardImageInputSchema,
        schedule_chart_delivery: scheduleChartDeliveryInputSchema,
        schedule_dashboard_delivery: scheduleDashboardDeliveryInputSchema,
    };

    const executeTool = async (
        toolName: string,
        rawInput: unknown,
        principal: AgentPrincipal,
        options: AgentToolRuntimeOptions = {},
    ): Promise<unknown> => {
        if (
            !EXPORT_TOOL_NAMES.includes(toolName as ExportToolName) ||
            !(toolName in handlers)
        ) {
            throw new AgentToolError(
                'UNKNOWN_TOOL',
                `Tool "${toolName}" is not recognized.`,
            );
        }
        const name = toolName as ExportToolName;
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
        toolNames: EXPORT_TOOL_NAMES,
    };
};
