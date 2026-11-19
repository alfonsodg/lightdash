// HTTP seam for the export tools (Slice F).
//
// The host owns the transport: base URL and caller credentials come from
// the deploy environment, never from tools. Only export, scheduler and
// scheduler job-status routes are addressable here — no deprecated v1
// write path (`POST /saved`, `PATCH /saved`) exists in this module.

import { type AgentToolRuntimeOptions } from '../tools/agentToolTypes';
import { createJsonFetchClient } from '../tools/httpFetchClient';

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
    timeoutMs?: number;
}

// Host-owned HTTP adapter behind the ExportFetch seam: base URL and
// caller credentials come from the deploy environment, never from tools.
export const createExportFetchClient = (
    options: ExportFetchClientOptions,
): ExportFetch =>
    createJsonFetchClient({
        baseUrl: options.baseUrl,
        domainLabel: 'export',
        fetchImpl: options.fetchImpl,
        headers: options.headers,
        timeoutMs: options.timeoutMs,
    });
