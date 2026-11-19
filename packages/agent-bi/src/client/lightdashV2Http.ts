import { getAgentBiConfig } from '../config/agentBiConfig';
import {
    LightdashV2ClientError,
    type FetchImpl,
    type LightdashV2ClientOptions,
    type V2ClientErrorKind,
    type V2QueryResult,
    type V2ResultRow,
} from './lightdashV2Types';

export const scrubBrand = (value: string): string =>
    value.replace(/lightdash/gi, 'server');

export type ResolvedConfig = {
    baseUrl: string;
    headers: Record<string, string>;
    fetchImpl: FetchImpl;
    maxRows: number;
    timeoutMs: number;
    pollInitialDelayMs: number;
    pollMaxDelayMs: number;
    pollMaxAttempts: number;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    cancelOnAbort: boolean;
};

const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

export const resolveV2Config = (
    options: LightdashV2ClientOptions,
): ResolvedConfig => {
    const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    if (!options.baseUrl || !options.baseUrl.trim()) {
        throw new LightdashV2ClientError(
            'bad_request',
            'A base URL is required',
        );
    }
    const config = getAgentBiConfig();
    return {
        baseUrl: options.baseUrl.replace(/\/+$/, ''),
        headers: { ...(options.headers ?? {}) },
        fetchImpl,
        maxRows: options.maxRows ?? config.maxRows,
        timeoutMs: options.timeoutMs ?? config.timeoutMs,
        pollInitialDelayMs:
            options.pollInitialDelayMs ?? config.v2PollInitialDelayMs,
        pollMaxDelayMs: options.pollMaxDelayMs ?? config.v2PollMaxDelayMs,
        pollMaxAttempts: options.pollMaxAttempts ?? config.v2PollMaxAttempts,
        sleep: options.sleepImpl ?? defaultSleep,
        now: options.nowImpl ?? Date.now,
        cancelOnAbort: options.cancelOnAbort ?? true,
    };
};

export const assertId = (value: string, label: string): void => {
    if (!value || !value.trim()) {
        throw new LightdashV2ClientError(
            'bad_request',
            `A ${label} is required`,
        );
    }
};

export const assertNonEmpty = (value: string, label: string): void =>
    assertId(value, label);

export const throwIfAborted = (signal?: AbortSignal | null): void => {
    if (signal?.aborted) {
        throw new LightdashV2ClientError('aborted', 'The request was aborted');
    }
};

const mapHttpStatus = (status: number): V2ClientErrorKind => {
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'server';
    return 'bad_request';
};

export const requestJson = async (
    config: ResolvedConfig,
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | null | undefined,
    timeoutMs: number | undefined,
): Promise<{ status: number; json: unknown }> => {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer =
        timeoutMs === undefined
            ? undefined
            : setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await config.fetchImpl(`${config.baseUrl}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...config.headers,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
        const text = await response.text();
        let json: unknown = null;
        if (text) {
            try {
                json = JSON.parse(text) as unknown;
            } catch {
                json = null;
            }
        }
        return { status: response.status, json };
    } catch {
        if (controller.signal.aborted || signal?.aborted) {
            throw new LightdashV2ClientError(
                'aborted',
                'The request was aborted',
            );
        }
        throw new LightdashV2ClientError(
            'network',
            'The request failed before reaching the server',
        );
    } finally {
        signal?.removeEventListener('abort', onAbort);
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
};

export const unwrapResults = <T>(json: unknown, status: number): T => {
    if (json !== null && typeof json === 'object' && 'results' in json) {
        return (json as { results: T }).results;
    }
    if (json !== null && typeof json === 'object' && 'status' in json) {
        const envelope = json as { status?: unknown };
        if (envelope.status === 'error') {
            throw new LightdashV2ClientError(
                mapHttpStatus(status),
                `The request failed (status ${status})`,
                status,
            );
        }
    }
    return json as T;
};

export const checkHttpStatus = (status: number): void => {
    if (status >= 200 && status < 300) {
        return;
    }
    throw new LightdashV2ClientError(
        mapHttpStatus(status),
        `The request failed (status ${status})`,
        status,
    );
};

export const parseQueryResult = (json: unknown): V2QueryResult => {
    if (json === null || typeof json !== 'object') {
        throw new LightdashV2ClientError(
            'server',
            'The server returned an unexpected response',
        );
    }
    const record = json as Record<string, unknown>;
    const { status, queryUuid } = record;
    if (typeof queryUuid !== 'string' || !queryUuid) {
        throw new LightdashV2ClientError(
            'server',
            'The server returned an unexpected response',
        );
    }
    if (status === 'ready') {
        const { page, pageSize } = record;
        return {
            status: 'ready',
            queryUuid,
            columns:
                record.columns !== null && typeof record.columns === 'object'
                    ? (record.columns as Record<string, unknown>)
                    : {},
            rows: Array.isArray(record.rows)
                ? (record.rows as V2ResultRow[])
                : [],
            page: typeof page === 'number' ? page : 1,
            pageSize: typeof pageSize === 'number' ? pageSize : 0,
            totalPageCount:
                typeof record.totalPageCount === 'number'
                    ? record.totalPageCount
                    : null,
            totalResults:
                typeof record.totalResults === 'number'
                    ? record.totalResults
                    : null,
            nextPage:
                typeof record.nextPage === 'number' ? record.nextPage : null,
            previousPage:
                typeof record.previousPage === 'number'
                    ? record.previousPage
                    : null,
        };
    }
    if (
        status === 'pending' ||
        status === 'queued' ||
        status === 'executing' ||
        status === 'cancelled'
    ) {
        return { status, queryUuid };
    }
    if (status === 'error' || status === 'expired') {
        const { error } = record;
        return {
            status,
            queryUuid,
            error: typeof error === 'string' ? error : null,
        };
    }
    throw new LightdashV2ClientError(
        'server',
        'The server returned an unexpected response',
    );
};
