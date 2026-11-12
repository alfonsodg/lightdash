// HTTP seam for the content-as-code tools (Slice E).
//
// The host owns the transport: base URL and caller credentials come from
// the deploy environment, never from tools. Only the canonical `/code/*`
// routes are addressable here — no deprecated v1 write path exists in
// this module.

import {
    AgentToolError,
    type AgentToolRuntimeOptions,
} from '../tools/agentToolTypes';

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
}

// Host-owned HTTP adapter behind the ContentFetch seam: base URL and
// caller credentials come from the deploy environment, never from tools.
export const createContentFetchClient = (
    options: ContentFetchClientOptions,
): ContentFetch => {
    if (!options.baseUrl || !options.baseUrl.trim()) {
        throw new AgentToolError(
            'INVALID_INPUT',
            'A base URL is required for content requests.',
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
                'The content request failed before reaching the server.',
            );
        }
        if (response.status < 200 || response.status >= 300) {
            throw new AgentToolError(
                'UPSTREAM_ERROR',
                `The content request failed (status ${response.status}).`,
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
