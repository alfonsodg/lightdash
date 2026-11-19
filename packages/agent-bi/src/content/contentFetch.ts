// HTTP seam for the content-as-code tools (Slice E).
//
// The host owns the transport: base URL and caller credentials come from
// the deploy environment, never from tools. Only the canonical `/code/*`
// routes are addressable here — no deprecated v1 write path exists in
// this module.

import { type AgentToolRuntimeOptions } from '../tools/agentToolTypes';
import { createJsonFetchClient } from '../tools/httpFetchClient';

export interface ContentFetchRequest {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | undefined>;
    body?: unknown;
}

export type ContentFetch = (
    request: ContentFetchRequest,
    options?: AgentToolRuntimeOptions,
) => Promise<unknown>;

const encodeProject = (projectUuid: string): string =>
    encodeURIComponent(projectUuid);

const encodeSlug = (slug: string): string => encodeURIComponent(slug);

export const buildCodeChartsPath = (projectUuid: string): string =>
    `/api/v1/projects/${encodeProject(projectUuid)}/code/charts`;

export const buildCodeChartItemPath = (
    projectUuid: string,
    slug: string,
): string => `${buildCodeChartsPath(projectUuid)}/${encodeSlug(slug)}`;

export const buildCodeSqlChartsPath = (projectUuid: string): string =>
    `/api/v1/projects/${encodeProject(projectUuid)}/code/sqlCharts`;

export const buildCodeSqlChartItemPath = (
    projectUuid: string,
    slug: string,
): string => `${buildCodeSqlChartsPath(projectUuid)}/${encodeSlug(slug)}`;

export const buildCodeDashboardsPath = (projectUuid: string): string =>
    `/api/v1/projects/${encodeProject(projectUuid)}/code/dashboards`;

export const buildCodeDashboardItemPath = (
    projectUuid: string,
    slug: string,
): string => `${buildCodeDashboardsPath(projectUuid)}/${encodeSlug(slug)}`;

export interface ContentFetchClientOptions {
    baseUrl: string;
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    headers?: Record<string, string>;
    timeoutMs?: number;
}

// Host-owned HTTP adapter behind the ContentFetch seam: base URL and
// caller credentials come from the deploy environment, never from tools.
export const createContentFetchClient = (
    options: ContentFetchClientOptions,
): ContentFetch =>
    createJsonFetchClient({
        baseUrl: options.baseUrl,
        domainLabel: 'content',
        fetchImpl: options.fetchImpl,
        headers: options.headers,
        timeoutMs: options.timeoutMs,
    });
