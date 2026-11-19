// Export tools (Slice F): chart image export, async dashboard exports with
// job polling to completion, and chart/dashboard scheduled deliveries.
// Fakes only at the HTTP seam; no live server, no database.

import { describe, expect, it } from 'vitest';
import type { AuditQueryClient } from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { defaultCapabilityToggles } from '../policy/capabilityPolicy';
import { AgentToolError } from '../tools/agentToolTypes';
import {
    buildDashboardExportsPath,
    buildDashboardSchedulersPath,
    buildSavedChartExportPath,
    buildSavedChartSchedulersPath,
    buildSchedulerJobStatusPath,
    type ExportFetch,
} from './exportFetch';
import {
    createExportTools,
    EXPORT_TOOL_NAMES,
    type ExportToolDeps,
} from './exportTools';

const PROJECT_UUID = '22222222-2222-4222-8222-222222222222';
const CHART_UUID = '33333333-3333-4333-8333-333333333333';
const DASHBOARD_UUID = '44444444-4444-4434-8444-444444444444';
const USER_UUID = '11111111-1111-4111-8111-111111111111';
const ORG_UUID = 'org-1';

const exporter = (): AgentPrincipal => ({
    ability: {
        can: (action: string, subject: string) =>
            action === 'create' && subject === 'ScheduledDeliveries',
    },
    authType: 'session',
    cacheKey: 'exporter',
    organizationUuid: ORG_UUID,
    userAttributesHash: 'abcd1234',
    userUuid: USER_UUID,
});

const viewer = (): AgentPrincipal => ({
    ability: { can: () => false },
    authType: 'session',
    cacheKey: 'export-viewer',
    organizationUuid: ORG_UUID,
    userAttributesHash: 'abcd1234',
    userUuid: USER_UUID,
});

type RecordedRequest = {
    body?: unknown;
    method: string;
    path: string;
    query?: Record<string, string | undefined>;
};

const setup = (options?: {
    fetch?: ExportFetch;
    toggles?: { export: boolean };
    poll?: Partial<ExportToolDeps['poll']>;
}) => {
    const recordedRequests: RecordedRequest[] = [];
    const recordedAudits: Array<{ text: string; params: unknown[] }> = [];
    const auditClient: AuditQueryClient = {
        query: async (text: string, params?: unknown[]) => {
            recordedAudits.push({ params: params ?? [], text });
            return undefined;
        },
    };
    const fetchImpl: ExportFetch =
        options?.fetch ??
        (async (request) => {
            recordedRequests.push(request);
            return { results: {}, status: 'ok' };
        });
    const exportFetch: ExportFetch = (request, fetchOptions) => {
        if (options?.fetch === undefined) {
            recordedRequests.push(request);
        }
        return fetchImpl(request, fetchOptions);
    };
    const deps: ExportToolDeps = {
        auditClient,
        exportFetch,
        policyContext: {
            toggles: {
                ...defaultCapabilityToggles(),
                ...(options?.toggles !== undefined
                    ? { export: options.toggles.export }
                    : {}),
            },
        },
        poll: {
            initialDelayMs: 0,
            maxAttempts: 5,
            maxDelayMs: 0,
            timeoutMs: 60_000,
            ...(options?.poll ?? {}),
        },
    };
    return {
        deps,
        recordedAudits,
        recordedRequests,
        tools: createExportTools(deps),
    };
};

const verdictOf = (params: unknown[]): string => {
    const metadata = JSON.parse(String(params[4])) as { verdict: string };
    return metadata.verdict;
};

const capabilityOf = (params: unknown[]): string => {
    const metadata = JSON.parse(String(params[4])) as { capability: string };
    return metadata.capability;
};

const schedulerBody = () => ({
    cron: '0 9 * * *',
    format: 'image',
    name: 'Morning digest',
    targets: [{ channel: 'email', recipient: 'team@example.com' }],
    timezone: 'UTC',
});

describe('export tool names', () => {
    it('exposes the five Phase-4 export tools', () => {
        expect([...EXPORT_TOOL_NAMES]).toEqual([
            'export_chart_image',
            'export_dashboard_image',
            'export_dashboard_csv',
            'schedule_chart_delivery',
            'schedule_dashboard_delivery',
        ]);
    });
});

describe('export gating', () => {
    it('rejects unknown tools without an audit row', async () => {
        const { recordedAudits, tools } = setup();
        await expect(
            tools.executeTool('export_everything', {}, exporter()),
        ).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
        expect(recordedAudits).toHaveLength(0);
    });

    it('rejects invalid input without an audit row', async () => {
        const { recordedAudits, tools } = setup();
        await expect(
            tools.executeTool(
                'export_chart_image',
                { chartUuid: 'not-a-uuid', projectUuid: PROJECT_UUID },
                exporter(),
            ),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(recordedAudits).toHaveLength(0);
    });

    it('denies viewers with one deny audit row and no HTTP call', async () => {
        const { recordedAudits, recordedRequests, tools } = setup();
        const error = await tools
            .executeTool(
                'export_chart_image',
                { chartUuid: CHART_UUID, projectUuid: PROJECT_UUID },
                viewer(),
            )
            .catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('POLICY_DENIED');
        expect(recordedRequests).toHaveLength(0);
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
        expect(capabilityOf(recordedAudits[0].params)).toBe('export');
    });

    it('denies when the export toggle is off', async () => {
        const { recordedAudits, tools } = setup({
            toggles: { export: false },
        });
        await expect(
            tools.executeTool(
                'schedule_chart_delivery',
                {
                    chartUuid: CHART_UUID,
                    projectUuid: PROJECT_UUID,
                    scheduler: schedulerBody(),
                },
                exporter(),
            ),
        ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
    });
});

describe('export_chart_image', () => {
    it('posts the saved-chart export route and returns the image URL', async () => {
        const { recordedAudits, recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                return {
                    results: 'https://files.example/img.png',
                    status: 'ok',
                };
            },
        });
        const result = await tools.executeTool(
            'export_chart_image',
            { chartUuid: CHART_UUID, projectUuid: PROJECT_UUID },
            exporter(),
        );
        expect(result).toEqual({
            chartUuid: CHART_UUID,
            imageUrl: 'https://files.example/img.png',
        });
        expect(recordedRequests).toHaveLength(1);
        expect(recordedRequests[0]).toMatchObject({
            method: 'POST',
            path: buildSavedChartExportPath(CHART_UUID),
            query: { projectUuid: PROJECT_UUID },
        });
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('allow');
    });

    it('treats a missing image URL as an upstream error', async () => {
        const { recordedAudits, tools } = setup({
            fetch: async () => ({ results: null, status: 'ok' }),
        });
        await expect(
            tools.executeTool(
                'export_chart_image',
                { chartUuid: CHART_UUID, projectUuid: PROJECT_UUID },
                exporter(),
            ),
        ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
    });
});

describe('export_dashboard_image', () => {
    it('schedules the image export and polls the job to completion', async () => {
        const { recordedAudits, recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                if (
                    request.path === buildDashboardExportsPath(DASHBOARD_UUID)
                ) {
                    return { results: { jobId: 'job-1' }, status: 'ok' };
                }
                if (request.path === buildSchedulerJobStatusPath('job-1')) {
                    const seen = recordedRequests.filter(
                        (entry) =>
                            entry.path === buildSchedulerJobStatusPath('job-1'),
                    ).length;
                    if (seen === 1) {
                        return {
                            results: { details: null, status: 'scheduled' },
                            status: 'ok',
                        };
                    }
                    return {
                        results: {
                            details: { url: 'https://files.example/d.png' },
                            status: 'completed',
                        },
                        status: 'ok',
                    };
                }
                throw new Error(`unexpected path ${request.path}`);
            },
        });
        const result = await tools.executeTool(
            'export_dashboard_image',
            { dashboardUuid: DASHBOARD_UUID, projectUuid: PROJECT_UUID },
            exporter(),
        );
        expect(result).toEqual({
            dashboardUuid: DASHBOARD_UUID,
            fileUrl: 'https://files.example/d.png',
            format: 'image',
            jobId: 'job-1',
        });
        expect(recordedRequests[0]).toMatchObject({
            body: { format: 'image' },
            method: 'POST',
            path: buildDashboardExportsPath(DASHBOARD_UUID),
        });
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('allow');
    });
});

describe('export_dashboard_csv', () => {
    it('sends csv format with options and polls to the download link', async () => {
        const { recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                if (
                    request.path === buildDashboardExportsPath(DASHBOARD_UUID)
                ) {
                    return { results: { jobId: 'job-2' }, status: 'ok' };
                }
                return {
                    results: {
                        details: { url: 'https://files.example/d.csv' },
                        status: 'completed',
                    },
                    status: 'ok',
                };
            },
        });
        const result = await tools.executeTool(
            'export_dashboard_csv',
            {
                dashboardUuid: DASHBOARD_UUID,
                formatted: true,
                limit: 'all',
                projectUuid: PROJECT_UUID,
            },
            exporter(),
        );
        expect(result).toEqual({
            dashboardUuid: DASHBOARD_UUID,
            fileUrl: 'https://files.example/d.csv',
            format: 'csv',
            jobId: 'job-2',
        });
        expect(recordedRequests[0]).toMatchObject({
            body: {
                format: 'csv',
                options: { formatted: true, limit: 'all' },
            },
            method: 'POST',
            path: buildDashboardExportsPath(DASHBOARD_UUID),
        });
    });

    it('treats a failed job as an upstream error with a deny audit', async () => {
        const { recordedAudits, tools } = setup({
            fetch: async (request) => {
                if (
                    request.path === buildDashboardExportsPath(DASHBOARD_UUID)
                ) {
                    return { results: { jobId: 'job-3' }, status: 'ok' };
                }
                return {
                    results: { details: null, status: 'error' },
                    status: 'ok',
                };
            },
        });
        await expect(
            tools.executeTool(
                'export_dashboard_csv',
                { dashboardUuid: DASHBOARD_UUID, projectUuid: PROJECT_UUID },
                exporter(),
            ),
        ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
    });

    it('treats completion without a link as an upstream error', async () => {
        const { recordedAudits, tools } = setup({
            fetch: async (request) => {
                if (
                    request.path === buildDashboardExportsPath(DASHBOARD_UUID)
                ) {
                    return { results: { jobId: 'job-4' }, status: 'ok' };
                }
                return {
                    results: { details: {}, status: 'completed' },
                    status: 'ok',
                };
            },
        });
        await expect(
            tools.executeTool(
                'export_dashboard_csv',
                { dashboardUuid: DASHBOARD_UUID, projectUuid: PROJECT_UUID },
                exporter(),
            ),
        ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
    });

    it('times out when the job never completes', async () => {
        const { recordedAudits, tools } = setup({
            fetch: async (request) => {
                if (
                    request.path === buildDashboardExportsPath(DASHBOARD_UUID)
                ) {
                    return { results: { jobId: 'job-5' }, status: 'ok' };
                }
                return {
                    results: { details: null, status: 'started' },
                    status: 'ok',
                };
            },
            poll: { maxAttempts: 2 },
        });
        await expect(
            tools.executeTool(
                'export_dashboard_image',
                { dashboardUuid: DASHBOARD_UUID, projectUuid: PROJECT_UUID },
                exporter(),
            ),
        ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
    });
});

describe('scheduled deliveries', () => {
    it('posts the saved-chart schedulers route and returns the id', async () => {
        const { recordedAudits, recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                return {
                    results: { schedulerUuid: 'sched-1' },
                    status: 'ok',
                };
            },
        });
        const result = await tools.executeTool(
            'schedule_chart_delivery',
            {
                chartUuid: CHART_UUID,
                projectUuid: PROJECT_UUID,
                scheduler: schedulerBody(),
            },
            exporter(),
        );
        expect(result).toEqual({
            chartUuid: CHART_UUID,
            schedulerUuid: 'sched-1',
        });
        expect(recordedRequests).toHaveLength(1);
        expect(recordedRequests[0].method).toBe('POST');
        expect(recordedRequests[0].path).toBe(
            buildSavedChartSchedulersPath(CHART_UUID),
        );
        expect(recordedRequests[0].body).toMatchObject({
            cron: '0 9 * * *',
            name: 'Morning digest',
        });
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('allow');
    });

    it('posts the dashboard schedulers route and returns the id', async () => {
        const { recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                return {
                    results: { schedulerUuid: 'sched-2' },
                    status: 'ok',
                };
            },
        });
        const result = await tools.executeTool(
            'schedule_dashboard_delivery',
            {
                dashboardUuidOrSlug: DASHBOARD_UUID,
                projectUuid: PROJECT_UUID,
                scheduler: schedulerBody(),
            },
            exporter(),
        );
        expect(result).toEqual({
            dashboardUuidOrSlug: DASHBOARD_UUID,
            schedulerUuid: 'sched-2',
        });
        expect(recordedRequests[0].path).toBe(
            buildDashboardSchedulersPath(DASHBOARD_UUID),
        );
    });

    it('treats a scheduler response without an id as an upstream error', async () => {
        const { recordedAudits, tools } = setup({
            fetch: async () => ({ results: {}, status: 'ok' }),
        });
        await expect(
            tools.executeTool(
                'schedule_dashboard_delivery',
                {
                    dashboardUuidOrSlug: 'weekly-review',
                    projectUuid: PROJECT_UUID,
                    scheduler: schedulerBody(),
                },
                exporter(),
            ),
        ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
    });
});

describe('export route hygiene', () => {
    it('only touches export, scheduler and job-status routes', async () => {
        const { recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                if (request.path === buildSavedChartExportPath(CHART_UUID)) {
                    return {
                        results: 'https://files.example/c.png',
                        status: 'ok',
                    };
                }
                if (
                    request.path === buildDashboardExportsPath(DASHBOARD_UUID)
                ) {
                    return { results: { jobId: 'job-9' }, status: 'ok' };
                }
                if (request.path === buildSchedulerJobStatusPath('job-9')) {
                    return {
                        results: {
                            details: { url: 'https://files.example/x.csv' },
                            status: 'completed',
                        },
                        status: 'ok',
                    };
                }
                return { results: { schedulerUuid: 'sched-9' }, status: 'ok' };
            },
        });
        await tools.executeTool(
            'export_chart_image',
            { chartUuid: CHART_UUID, projectUuid: PROJECT_UUID },
            exporter(),
        );
        await tools.executeTool(
            'export_dashboard_csv',
            { dashboardUuid: DASHBOARD_UUID, projectUuid: PROJECT_UUID },
            exporter(),
        );
        await tools.executeTool(
            'schedule_chart_delivery',
            {
                chartUuid: CHART_UUID,
                projectUuid: PROJECT_UUID,
                scheduler: schedulerBody(),
            },
            exporter(),
        );
        const allowedPrefixes = [
            '/api/v1/saved/',
            '/api/v2/dashboards/',
            '/api/v1/dashboards/',
            '/api/v1/schedulers/job/',
        ];
        for (const request of recordedRequests) {
            expect(request.method === 'GET' || request.method === 'POST').toBe(
                true,
            );
            expect(
                allowedPrefixes.some((prefix) =>
                    request.path.startsWith(prefix),
                ),
            ).toBe(true);
        }
    });

    it('keeps every thrown message free of brand strings', async () => {
        const { tools } = setup({
            fetch: async () => ({ results: null, status: 'ok' }),
        });
        const error = await tools
            .executeTool(
                'export_chart_image',
                { chartUuid: CHART_UUID, projectUuid: PROJECT_UUID },
                exporter(),
            )
            .catch((cause: unknown) => cause);
        const failures: string[] =
            error instanceof Error ? [error.message] : [];
        expect(failures.length).toBeGreaterThan(0);
        for (const message of failures) {
            expect(message).not.toMatch(/lightdash/i);
        }
    });
});
