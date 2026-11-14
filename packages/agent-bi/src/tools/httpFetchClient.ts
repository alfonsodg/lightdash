import { AgentToolError, type AgentToolRuntimeOptions } from './agentToolTypes';

export interface JsonFetchRequest {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | undefined>;
    body?: unknown;
}

export interface JsonFetchClientOptions {
    baseUrl: string;
    domainLabel: string;
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    headers?: Record<string, string>;
    timeoutMs?: number;
}

const buildQuerySuffix = (
    query: Record<string, string | undefined> | undefined,
): string => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) {
            params.set(key, value);
        }
    }
    return params.size > 0 ? `?${params.toString()}` : '';
};

const createRequestSignal = (
    externalSignal: AbortSignal | null | undefined,
    timeoutMs: number | undefined,
): { cleanup: () => void; signal: AbortSignal | undefined } => {
    if (
        (externalSignal === undefined || externalSignal === null) &&
        timeoutMs === undefined
    ) {
        return { cleanup: () => {}, signal: undefined };
    }
    const controller = new AbortController();
    const onAbort = (): void => {
        controller.abort();
    };
    if (externalSignal !== undefined && externalSignal !== null) {
        if (externalSignal.aborted) {
            controller.abort();
        } else {
            externalSignal.addEventListener('abort', onAbort, { once: true });
        }
    }
    const timer =
        timeoutMs !== undefined && timeoutMs > 0
            ? setTimeout(onAbort, timeoutMs)
            : undefined;
    return {
        cleanup: () => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            externalSignal?.removeEventListener('abort', onAbort);
        },
        signal: controller.signal,
    };
};

/** Shared JSON HTTP client with AbortSignal and timeout propagation. */
export const createJsonFetchClient = (
    options: JsonFetchClientOptions,
): ((
    request: JsonFetchRequest,
    runtimeOptions?: AgentToolRuntimeOptions,
) => Promise<unknown>) => {
    if (!options.baseUrl || !options.baseUrl.trim()) {
        throw new AgentToolError(
            'INVALID_INPUT',
            `A base URL is required for ${options.domainLabel} requests.`,
        );
    }
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));

    return async (request, runtimeOptions) => {
        const suffix = buildQuerySuffix(request.query);
        const { cleanup, signal } = createRequestSignal(
            runtimeOptions?.signal,
            options.timeoutMs,
        );
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
                ...(signal !== undefined ? { signal } : {}),
                ...(request.method === 'POST'
                    ? { body: JSON.stringify(request.body ?? {}) }
                    : {}),
            });
        } catch {
            throw new AgentToolError(
                'UPSTREAM_ERROR',
                `The ${options.domainLabel} request failed before reaching the server.`,
            );
        } finally {
            cleanup();
        }
        if (response.status < 200 || response.status >= 300) {
            throw new AgentToolError(
                'UPSTREAM_ERROR',
                `The ${options.domainLabel} request failed (status ${response.status}).`,
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
