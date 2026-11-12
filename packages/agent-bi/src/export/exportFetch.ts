// HTTP seam for the export tools (Slice F).
//
// The host owns the transport: base URL and caller credentials come from
// the deploy environment, never from tools. Only export, scheduler and
// scheduler job-status routes are addressable here — no deprecated v1
// write path (`POST /saved`, `PATCH /saved`) exists in this module.

import {
    AgentToolError,
    type AgentToolRuntimeOptions,
} from '../tools/agentToolTypes';

export interface ExportFetchRequest {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | undefined>;
    body?: unknown;
}

export type ExportFetch = (
    request: ExportFetchRequest,
    options?: AgentToolRuntimeOptions,
) => Promise<unknown>;

const encodeSegment = (value: string): string => encodeURIComponent(value);

// Sync chart image export through the headless browser
// (`exportSavedChartImage` in the backend).
export const buildSavedChartExportPath = (chartUuid: string): string =>
    `/api/v1/saved/${encodeSegment(chartUuid)}/export`;

// Async dashboard content export (`exportDashboardContentV2`); the
// response carries a job id polled on the schedulers job-status route.
export const buildDashboardExportsPath = (dashboardUuid: string): string =>
    `/api/v2/dashboards/${encodeSegment(dashboardUuid)}/exports`;

// Canonical async-job poll (`getSchedulerJobStatus`, v1 only).
export const buildSchedulerJobStatusPath = (jobId: string): string =>
    `/api/v1/schedulers/job/${encodeSegment(jobId)}/status`;

// Saved-chart scheduled delivery (`createSavedChartScheduler`).
export const buildSavedChartSchedulersPath = (chartUuid: string): string =>
    `/api/v1/saved/${encodeSegment(chartUuid)}/schedulers`;

// Dashboard scheduled delivery (`createDashboardScheduler`); the backend
// accepts a uuid or a slug here.
export const buildDashboardSchedulersPath = (
    dashboardUuidOrSlug: string,
): string =>
    `/api/v1/dashboards/${encodeSegment(dashboardUuidOrSlug)}/schedulers`;

export interface ExportFetchClientOptions {
    baseUrl: string;
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    headers?: Record<string, string>;
}

// Host-owned HTTP adapter behind the ExportFetch seam: base URL and
// caller credentials come from the deploy environment, never from tools.
export const createExportFetchClient = (
    options: ExportFetchClientOptions,
): ExportFetch => {
    if (!options.baseUrl || !options.baseUrl.trim()) {
        throw new AgentToolError(
            'INVALID_INPUT',
            'A base URL is required for export requests.',
        );
    }
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    return async (request) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(request.query ?? {})) {
            if (value !== undefined) {
                params.set(key, value);
            }
        }
        const suffix = params.size > 0 ? `?${params.toString()}` : '';
        let response: Response;
        try {
            response = await fetchImpl(`${baseUrl}${request.path}${suffix}`, {
                headers: {
                    Accept: 'application/json',
                    ...(options.headers ?? {}),
                    ...(request.method === 'POST'
                        ? { 'Content-Type': 'application/json' }
                        : {}),
                },
                method: request.method,
                ...(request.method === 'POST'
                    ? { body: JSON.stringify(request.body ?? {}) }
                    : {}),
            });
        } catch {
            throw new AgentToolError(
                'UPSTREAM_ERROR',
                'The export request failed before reaching the server.',
            );
        }
        if (response.status < 200 || response.status >= 300) {
            throw new AgentToolError(
                'UPSTREAM_ERROR',
                `The export request failed (status ${response.status}).`,
            );
        }
        const text = await response.text();
        if (!text) {
            return null;
        }
        try {
            return JSON.parse(text) as unknown;
        } catch {
            throw new AgentToolError(
                'UPSTREAM_ERROR',
                'The server returned a response the tool could not read.',
            );
        }
    };
};
