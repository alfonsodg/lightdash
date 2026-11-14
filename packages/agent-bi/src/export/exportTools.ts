import { z } from 'zod';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import {
    AgentToolError,
    formatValidationError,
    type AgentToolRuntimeOptions,
} from '../tools/agentToolTypes';
import {
    buildDashboardExportsPath,
    buildDashboardSchedulersPath,
    buildSavedChartExportPath,
    buildSavedChartSchedulersPath,
} from './exportFetch';
import {
    asRecord,
    assertAuthorizedDelivery,
    dashboardExportBody,
    enforceExportSqlGuard,
    jobIdOf,
    pollJobToFileUrl,
    requireExportDeps,
    runGuardedExport,
    schedulerUuidOf,
    unwrapResults,
    withoutResourceIds,
    type InvokeFn,
} from './exportHelpers';
import {
    dashboardExportOutputSchema,
    EXPORT_TOOL_NAMES,
    exportChartImageInputSchema,
    exportChartImageOutputSchema,
    exportDashboardCsvInputSchema,
    exportDashboardImageInputSchema,
    scheduleChartDeliveryInputSchema,
    scheduleChartDeliveryOutputSchema,
    scheduleDashboardDeliveryInputSchema,
    scheduleDashboardDeliveryOutputSchema,
    type DashboardExportOutput,
    type ExportChartImageInput,
    type ExportChartImageOutput,
    type ExportDashboardCsvInput,
    type ExportDashboardImageInput,
    type ExportToolDeps,
    type ExportToolName,
    type ScheduleChartDeliveryInput,
    type ScheduleChartDeliveryOutput,
    type ScheduleDashboardDeliveryInput,
    type ScheduleDashboardDeliveryOutput,
} from './exportSchemas';

export { AgentToolError } from '../tools/agentToolTypes';
export {
    EXPORT_CAPABILITY,
    EXPORT_TOOL_NAMES,
    dashboardExportOutputSchema,
    defaultExportPollConfig,
    exportChartImageInputSchema,
    exportChartImageOutputSchema,
    exportDashboardCsvInputSchema,
    exportDashboardImageInputSchema,
    scheduleChartDeliveryInputSchema,
    scheduleChartDeliveryOutputSchema,
    scheduleDashboardDeliveryInputSchema,
    scheduleDashboardDeliveryOutputSchema,
    type DashboardExportOutput,
    type ExportChartImageInput,
    type ExportChartImageOutput,
    type ExportDashboardCsvInput,
    type ExportDashboardImageInput,
    type ExportPollConfig,
    type ExportToolDeps,
    type ExportToolName,
    type ScheduleChartDeliveryInput,
    type ScheduleChartDeliveryOutput,
    type ScheduleDashboardDeliveryInput,
    type ScheduleDashboardDeliveryOutput,
} from './exportSchemas';

export const createExportTools = (deps: ExportToolDeps) => {
    requireExportDeps(deps);

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
        input: ExportDashboardImageInput | ExportDashboardCsvInput,
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
                    if (deps.resolveChartSql) {
                        const provenance = await deps.resolveChartSql(
                            input.projectUuid,
                            input.chartUuid,
                        );
                        enforceExportSqlGuard(deps, principal, provenance);
                    }
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
                async () => {
                    if (deps.resolveDashboardSqlCharts) {
                        const charts = await deps.resolveDashboardSqlCharts(
                            input.projectUuid,
                            input.dashboardUuid,
                        );
                        if (charts === null) {
                            throw new AgentToolError(
                                'GUARD_DENIED',
                                'Dashboard SQL chart provenance cannot be verified.',
                            );
                        }
                        for (const chart of charts) {
                            enforceExportSqlGuard(deps, principal, chart);
                        }
                    }
                    return scheduleExport('image', input, options);
                },
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
                async () => {
                    if (deps.resolveDashboardSqlCharts) {
                        const charts = await deps.resolveDashboardSqlCharts(
                            input.projectUuid,
                            input.dashboardUuid,
                        );
                        if (charts === null) {
                            throw new AgentToolError(
                                'GUARD_DENIED',
                                'Dashboard SQL chart provenance cannot be verified.',
                            );
                        }
                        for (const chart of charts) {
                            enforceExportSqlGuard(deps, principal, chart);
                        }
                    }
                    return scheduleExport('csv', input, options);
                },
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
                    if (deps.resolveChartSql) {
                        const provenance = await deps.resolveChartSql(
                            input.projectUuid,
                            input.chartUuid,
                        );
                        enforceExportSqlGuard(deps, principal, provenance);
                    }
                    await assertAuthorizedDelivery(
                        deps,
                        principal,
                        input.projectUuid,
                        input.scheduler.targets,
                    );
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
                    if (deps.resolveDashboardSqlCharts) {
                        const charts = await deps.resolveDashboardSqlCharts(
                            input.projectUuid,
                            input.dashboardUuidOrSlug,
                        );
                        if (charts === null) {
                            throw new AgentToolError(
                                'GUARD_DENIED',
                                'Dashboard SQL chart provenance cannot be verified.',
                            );
                        }
                        for (const chart of charts) {
                            enforceExportSqlGuard(deps, principal, chart);
                        }
                    }
                    await assertAuthorizedDelivery(
                        deps,
                        principal,
                        input.projectUuid,
                        input.scheduler.targets,
                    );
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
