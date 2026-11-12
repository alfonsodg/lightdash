// Typed client over the v2 async query APIs (Slice B).
//
// Poll-then-fetch only: every execute call returns a queryUuid that must be
// polled with getQueryResults until it reaches a terminal status. A queued
// queryUuid is never treated as a result. No deprecated v1 route is
// referenced anywhere in this module.

export type V2LifecycleStatus =
    | 'pending'
    | 'queued'
    | 'executing'
    | 'cancelled'
    | 'ready'
    | 'error'
    | 'expired';

export type V2ClientErrorKind =
    | 'bad_request'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'server'
    | 'timeout'
    | 'aborted'
    | 'query_error'
    | 'query_expired'
    | 'query_cancelled'
    | 'network';

export class LightdashV2ClientError extends Error {
    readonly kind: V2ClientErrorKind;
    readonly status: number | null;

    constructor(
        kind: V2ClientErrorKind,
        message: string,
        status: number | null = null,
    ) {
        super(message);
        this.name = 'LightdashV2ClientError';
        this.kind = kind;
        this.status = status;
    }
}

// White-label: server text is data, never our wording — scrub brand names
// before surfacing it in an error message.
const scrubBrand = (value: string): string =>
    value.replace(/lightdash/gi, 'server');

const DEFAULT_MAX_ROWS = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INITIAL_DELAY_MS = 250;
const DEFAULT_POLL_MAX_DELAY_MS = 5_000;
const DEFAULT_POLL_MAX_ATTEMPTS = 60;
const DEFAULT_RESULTS_PAGE_SIZE = 500;

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface LightdashV2ClientOptions {
    baseUrl: string;
    // Caller-supplied headers (personal token, session cookie, ...). The
    // client never invents an auth scheme; tokens stay out of errors.
    headers?: Record<string, string>;
    fetchImpl?: FetchImpl;
    // Row cap applied to every pageSize (AGENT_MAX_ROWS semantics).
    maxRows?: number;
    // Overall deadline per poll/run call (AGENT_QUERY_TIMEOUT_MS semantics).
    timeoutMs?: number;
    pollInitialDelayMs?: number;
    pollMaxDelayMs?: number;
    pollMaxAttempts?: number;
    // Injected for deterministic unit tests (no real timers, no real clock).
    sleepImpl?: (ms: number) => Promise<void>;
    nowImpl?: () => number;
    // Best-effort POST /cancel when a poll aborts or times out.
    cancelOnAbort?: boolean;
}

export interface V2MetricQueryBody {
    exploreName: string;
    dimensions: string[];
    metrics: string[];
    filters: Record<string, unknown>;
    sorts: Array<{ fieldId: string; descending?: boolean | null }>;
    limit: number;
    tableCalculations: [];
    timezone?: string | null;
}

export interface V2FieldValueSearchBody {
    table: string;
    fieldId: string;
    search: string;
    limit?: number;
    filters?: Record<string, unknown>;
}

export interface V2UnderlyingDataBody {
    underlyingDataSourceQueryUuid: string;
    underlyingDataItemId?: string;
    filters: Record<string, unknown>;
    limit?: number | null;
    sorts?: Array<{ fieldId: string; descending?: boolean | null }>;
}

export interface V2SavedChartBody {
    chartUuid: string;
    versionUuid?: string;
    limit?: number | null;
}

export interface V2DashboardChartBody {
    chartUuid: string;
    tileUuid: string;
    dashboardUuid: string;
    dashboardFilters: Record<string, unknown>;
    dashboardSorts?: Array<{ fieldId: string; descending?: boolean | null }>;
    limit?: number | null;
}

export interface V2SqlBody {
    sql: string;
    limit?: number;
}

export interface V2ComposeBody {
    queries: ReadonlyArray<Record<string, unknown>>;
    parameters?: Record<string, unknown>;
    invalidateCache?: boolean;
}

export interface V2ExecuteResult {
    queryUuid: string;
}

export interface V2ComposeExecuteResult {
    queries: Array<{ queryUuid: string }>;
}

export type V2ResultRow = Record<string, unknown>;

export interface V2ReadyPage {
    status: 'ready';
    queryUuid: string;
    columns: Record<string, unknown>;
    rows: V2ResultRow[];
    page: number;
    pageSize: number;
    totalPageCount: number | null;
    totalResults: number | null;
    nextPage: number | null;
    previousPage: number | null;
}

export interface V2PendingResult {
    status: 'pending' | 'queued' | 'executing' | 'cancelled';
    queryUuid: string;
}

export interface V2FailedResult {
    status: 'error' | 'expired';
    queryUuid: string;
    error: string | null;
}

export type V2QueryResult = V2ReadyPage | V2PendingResult | V2FailedResult;

export interface V2SourceQueryStatus {
    queryUuid: string;
    status: V2LifecycleStatus;
    error: string | null;
}

export interface PollOptions {
    signal?: AbortSignal | null;
    timeoutMs?: number;
    page?: number;
    pageSize?: number;
}

export interface LightdashV2Client {
    executeMetricQuery(
        projectUuid: string,
        query: V2MetricQueryBody,
        extra?: { limit?: number | null },
    ): Promise<V2ExecuteResult>;
    executeFieldValueSearch(
        projectUuid: string,
        body: V2FieldValueSearchBody,
    ): Promise<V2ExecuteResult>;
    executeUnderlyingData(
        projectUuid: string,
        body: V2UnderlyingDataBody,
    ): Promise<V2ExecuteResult>;
    executeSavedChart(
        projectUuid: string,
        body: V2SavedChartBody,
    ): Promise<V2ExecuteResult>;
    executeDashboardChart(
        projectUuid: string,
        body: V2DashboardChartBody,
    ): Promise<V2ExecuteResult>;
    executeSql(projectUuid: string, body: V2SqlBody): Promise<V2ExecuteResult>;
    executeComposeQueries(
        projectUuid: string,
        body: V2ComposeBody,
    ): Promise<V2ComposeExecuteResult>;
    getQueryResults(
        projectUuid: string,
        queryUuid: string,
        options?: {
            page?: number;
            pageSize?: number;
            signal?: AbortSignal | null;
        },
    ): Promise<V2QueryResult>;
    getSourceQueryStatus(
        projectUuid: string,
        queryUuids: string[],
        signal?: AbortSignal | null,
    ): Promise<V2SourceQueryStatus[]>;
    cancelQuery(projectUuid: string, queryUuid: string): Promise<void>;
    pollQueryToReady(
        projectUuid: string,
        queryUuid: string,
        options?: PollOptions,
    ): Promise<V2ReadyPage>;
    runMetricQuery(
        projectUuid: string,
        query: V2MetricQueryBody,
        options?: PollOptions & { limit?: number | null },
    ): Promise<V2ReadyPage>;
    runSqlQuery(
        projectUuid: string,
        body: V2SqlBody,
        options?: PollOptions,
    ): Promise<V2ReadyPage>;
}

type ResolvedConfig = {
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

const resolveConfig = (options: LightdashV2ClientOptions): ResolvedConfig => {
    const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    if (!options.baseUrl || !options.baseUrl.trim()) {
        throw new LightdashV2ClientError(
            'bad_request',
            'A base URL is required',
        );
    }
    return {
        baseUrl: options.baseUrl.replace(/\/+$/, ''),
        headers: { ...(options.headers ?? {}) },
        fetchImpl,
        maxRows: options.maxRows ?? DEFAULT_MAX_ROWS,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        pollInitialDelayMs:
            options.pollInitialDelayMs ?? DEFAULT_POLL_INITIAL_DELAY_MS,
        pollMaxDelayMs: options.pollMaxDelayMs ?? DEFAULT_POLL_MAX_DELAY_MS,
        pollMaxAttempts: options.pollMaxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS,
        sleep: options.sleepImpl ?? defaultSleep,
        now: options.nowImpl ?? Date.now,
        cancelOnAbort: options.cancelOnAbort ?? true,
    };
};

const assertId = (value: string, label: string): void => {
    if (!value || !value.trim()) {
        throw new LightdashV2ClientError(
            'bad_request',
            `A ${label} is required`,
        );
    }
};

const assertNonEmpty = (value: string, label: string): void =>
    assertId(value, label);

const throwIfAborted = (signal?: AbortSignal | null): void => {
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

// One HTTP call with a caller signal plus a deadline-derived timeout.
// Builds its own controller so fakes and old runtimes need no
// AbortSignal.any / AbortSignal.timeout support.
const requestJson = async (
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
    } catch (error) {
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

const unwrapResults = <T>(json: unknown, status: number): T => {
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

const checkHttpStatus = (status: number): void => {
    if (status >= 200 && status < 300) {
        return;
    }
    throw new LightdashV2ClientError(
        mapHttpStatus(status),
        `The request failed (status ${status})`,
        status,
    );
};

const parseQueryResult = (json: unknown): V2QueryResult => {
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

export const createLightdashV2Client = (
    options: LightdashV2ClientOptions,
): LightdashV2Client => {
    const config = resolveConfig(options);

    const effectivePageSize = (pageSize?: number): number => {
        const requested = pageSize ?? DEFAULT_RESULTS_PAGE_SIZE;
        return Math.max(1, Math.min(requested, config.maxRows));
    };

    const postExecute = async <T>(
        projectUuid: string,
        path: string,
        body: unknown,
        signal?: AbortSignal | null,
    ): Promise<T> => {
        assertId(projectUuid, 'project identifier');
        throwIfAborted(signal);
        const { status, json } = await requestJson(
            config,
            'POST',
            `/api/v2/projects/${encodeURIComponent(projectUuid)}${path}`,
            body,
            signal,
            undefined,
        );
        checkHttpStatus(status);
        return unwrapResults<T>(json, status);
    };

    const parseExecuteResult = (json: unknown): V2ExecuteResult => {
        if (json === null || typeof json !== 'object') {
            throw new LightdashV2ClientError(
                'server',
                'The server returned an unexpected response',
            );
        }
        const { queryUuid } = json as { queryUuid?: unknown };
        if (typeof queryUuid !== 'string' || !queryUuid) {
            throw new LightdashV2ClientError(
                'server',
                'The server returned an unexpected response',
            );
        }
        return { queryUuid };
    };

    const getQueryResults = async (
        projectUuid: string,
        queryUuid: string,
        queryOptions?: {
            page?: number;
            pageSize?: number;
            signal?: AbortSignal | null;
        },
    ): Promise<V2QueryResult> => {
        assertId(projectUuid, 'project identifier');
        assertId(queryUuid, 'query identifier');
        throwIfAborted(queryOptions?.signal);
        const page = queryOptions?.page ?? 1;
        if (!Number.isInteger(page) || page < 1) {
            throw new LightdashV2ClientError(
                'bad_request',
                'Page numbers start at 1',
            );
        }
        const pageSize = effectivePageSize(queryOptions?.pageSize);
        const { status, json } = await requestJson(
            config,
            'GET',
            `/api/v2/projects/${encodeURIComponent(projectUuid)}/query/${encodeURIComponent(queryUuid)}?page=${page}&pageSize=${pageSize}`,
            undefined,
            queryOptions?.signal,
            undefined,
        );
        checkHttpStatus(status);
        return parseQueryResult(unwrapResults<unknown>(json, status));
    };

    const cancelQuery = async (
        projectUuid: string,
        queryUuid: string,
    ): Promise<void> => {
        assertId(projectUuid, 'project identifier');
        assertId(queryUuid, 'query identifier');
        const { status } = await requestJson(
            config,
            'POST',
            `/api/v2/projects/${encodeURIComponent(projectUuid)}/query/${encodeURIComponent(queryUuid)}/cancel`,
            {},
            undefined,
            undefined,
        );
        checkHttpStatus(status);
    };

    const bestEffortCancel = async (
        projectUuid: string,
        queryUuid: string,
    ): Promise<void> => {
        if (!config.cancelOnAbort) {
            return;
        }
        try {
            await cancelQuery(projectUuid, queryUuid);
        } catch {
            // Cancellation is advisory; the typed error below carries the outcome.
        }
    };

    // Deterministic exponential backoff via recursion (no await-in-loop):
    // delay(n) = min(initial * 2^n, max), no jitter.
    const pollStep = async (
        projectUuid: string,
        queryUuid: string,
        poll: Required<Omit<PollOptions, 'signal'>> & {
            signal?: AbortSignal | null;
        },
        deadline: number,
        attempt: number,
    ): Promise<V2ReadyPage> => {
        throwIfAborted(poll.signal);
        const result = await getQueryResults(projectUuid, queryUuid, {
            page: poll.page,
            pageSize: poll.pageSize,
            signal: poll.signal,
        });
        if (result.status === 'ready') {
            return result;
        }
        if (result.status === 'error') {
            throw new LightdashV2ClientError(
                'query_error',
                result.error
                    ? `The query failed: ${scrubBrand(result.error).slice(0, 500)}`
                    : 'The query failed',
            );
        }
        if (result.status === 'expired') {
            throw new LightdashV2ClientError(
                'query_expired',
                'The query results expired before they were read',
            );
        }
        if (result.status === 'cancelled') {
            throw new LightdashV2ClientError(
                'query_cancelled',
                'The query was cancelled',
            );
        }
        if (attempt + 1 >= config.pollMaxAttempts) {
            throw new LightdashV2ClientError(
                'timeout',
                'The query did not finish in time',
            );
        }
        const remaining = deadline - config.now();
        if (remaining <= 0) {
            throw new LightdashV2ClientError(
                'timeout',
                'The query did not finish in time',
            );
        }
        const delay = Math.min(
            config.pollInitialDelayMs * 2 ** attempt,
            config.pollMaxDelayMs,
            remaining,
        );
        try {
            await config.sleep(delay);
        } catch {
            throw new LightdashV2ClientError(
                'aborted',
                'The request was aborted',
            );
        }
        if (poll.signal?.aborted) {
            throw new LightdashV2ClientError(
                'aborted',
                'The request was aborted',
            );
        }
        return pollStep(projectUuid, queryUuid, poll, deadline, attempt + 1);
    };

    const pollQueryToReady = async (
        projectUuid: string,
        queryUuid: string,
        pollOptions?: PollOptions,
    ): Promise<V2ReadyPage> => {
        assertId(projectUuid, 'project identifier');
        assertId(queryUuid, 'query identifier');
        throwIfAborted(pollOptions?.signal);
        const timeout = pollOptions?.timeoutMs ?? config.timeoutMs;
        const poll = {
            signal: pollOptions?.signal,
            timeoutMs: timeout,
            page: pollOptions?.page ?? 1,
            pageSize: effectivePageSize(pollOptions?.pageSize),
        };
        try {
            return await pollStep(
                projectUuid,
                queryUuid,
                poll,
                config.now() + timeout,
                0,
            );
        } catch (error) {
            if (
                error instanceof LightdashV2ClientError &&
                (error.kind === 'aborted' || error.kind === 'timeout') &&
                config.cancelOnAbort
            ) {
                await bestEffortCancel(projectUuid, queryUuid);
            }
            throw error;
        }
    };

    return {
        executeMetricQuery: async (projectUuid, query, extra) => {
            assertNonEmpty(query.exploreName, 'explore name');
            const body: Record<string, unknown> = { query };
            if (extra?.limit !== undefined) {
                body.limit = extra.limit;
            }
            return parseExecuteResult(
                await postExecute(projectUuid, '/query/metric-query', body),
            );
        },
        executeFieldValueSearch: async (projectUuid, body) => {
            assertNonEmpty(body.table, 'table name');
            assertNonEmpty(body.fieldId, 'field identifier');
            return parseExecuteResult(
                await postExecute(projectUuid, '/query/field-values', {
                    table: body.table,
                    fieldId: body.fieldId,
                    search: body.search,
                    ...(body.limit !== undefined
                        ? { limit: Math.min(body.limit, config.maxRows) }
                        : {}),
                    ...(body.filters !== undefined
                        ? { filters: body.filters }
                        : {}),
                }),
            );
        },
        executeUnderlyingData: async (projectUuid, body) => {
            assertId(
                body.underlyingDataSourceQueryUuid,
                'source query identifier',
            );
            return parseExecuteResult(
                await postExecute(projectUuid, '/query/underlying-data', body),
            );
        },
        executeSavedChart: async (projectUuid, body) => {
            assertNonEmpty(body.chartUuid, 'chart identifier');
            return parseExecuteResult(
                await postExecute(projectUuid, '/query/chart', body),
            );
        },
        executeDashboardChart: async (projectUuid, body) => {
            assertNonEmpty(body.chartUuid, 'chart identifier');
            assertNonEmpty(body.tileUuid, 'tile identifier');
            assertNonEmpty(body.dashboardUuid, 'dashboard identifier');
            return parseExecuteResult(
                await postExecute(projectUuid, '/query/dashboard-chart', body),
            );
        },
        executeSql: async (projectUuid, body) => {
            assertNonEmpty(body.sql, 'SQL text');
            return parseExecuteResult(
                await postExecute(projectUuid, '/query/sql', {
                    sql: body.sql,
                    ...(body.limit !== undefined
                        ? { limit: Math.min(body.limit, config.maxRows) }
                        : {}),
                }),
            );
        },
        executeComposeQueries: async (projectUuid, body) => {
            if (body.queries.length === 0) {
                throw new LightdashV2ClientError(
                    'bad_request',
                    'A compose pipeline needs at least one query',
                );
            }
            const json = await postExecute<unknown>(
                projectUuid,
                '/query-sources/queries',
                {
                    queries: [...body.queries],
                    ...(body.parameters !== undefined
                        ? { parameters: body.parameters }
                        : {}),
                    ...(body.invalidateCache !== undefined
                        ? { invalidateCache: body.invalidateCache }
                        : {}),
                },
            );
            if (json === null || typeof json !== 'object') {
                throw new LightdashV2ClientError(
                    'server',
                    'The server returned an unexpected response',
                );
            }
            const { queries } = json as { queries?: unknown };
            if (!Array.isArray(queries)) {
                throw new LightdashV2ClientError(
                    'server',
                    'The server returned an unexpected response',
                );
            }
            return {
                queries: queries.map((entry) => {
                    const { queryUuid } = entry as { queryUuid?: unknown };
                    if (typeof queryUuid !== 'string' || !queryUuid) {
                        throw new LightdashV2ClientError(
                            'server',
                            'The server returned an unexpected response',
                        );
                    }
                    return { queryUuid };
                }),
            };
        },
        getQueryResults,
        getSourceQueryStatus: async (projectUuid, queryUuids, signal) => {
            assertId(projectUuid, 'project identifier');
            if (queryUuids.length === 0) {
                throw new LightdashV2ClientError(
                    'bad_request',
                    'At least one query identifier is required',
                );
            }
            throwIfAborted(signal);
            const params = queryUuids
                .map(
                    (queryUuid) =>
                        `queryUuids=${encodeURIComponent(queryUuid)}`,
                )
                .join('&');
            const { status, json } = await requestJson(
                config,
                'GET',
                `/api/v2/projects/${encodeURIComponent(projectUuid)}/query-sources/queries/status?${params}`,
                undefined,
                signal,
                undefined,
            );
            checkHttpStatus(status);
            const unwrapped = unwrapResults<unknown>(json, status);
            if (
                unwrapped === null ||
                typeof unwrapped !== 'object' ||
                !Array.isArray((unwrapped as { statuses?: unknown }).statuses)
            ) {
                throw new LightdashV2ClientError(
                    'server',
                    'The server returned an unexpected response',
                );
            }
            return (
                (unwrapped as { statuses: Array<Record<string, unknown>> })
                    .statuses as Array<Record<string, unknown>>
            ).map((entry) => ({
                queryUuid:
                    typeof entry.queryUuid === 'string' ? entry.queryUuid : '',
                status: entry.status as V2LifecycleStatus,
                error: typeof entry.error === 'string' ? entry.error : null,
            }));
        },
        cancelQuery,
        pollQueryToReady,
        runMetricQuery: async (projectUuid, query, runOptions) => {
            assertNonEmpty(query.exploreName, 'explore name');
            const executed = await postExecute<unknown>(
                projectUuid,
                '/query/metric-query',
                {
                    query,
                    ...(runOptions?.limit !== undefined
                        ? { limit: runOptions.limit }
                        : {}),
                },
                runOptions?.signal,
            );
            return pollQueryToReady(
                projectUuid,
                parseExecuteResult(executed).queryUuid,
                runOptions,
            );
        },
        runSqlQuery: async (projectUuid, body, runOptions) => {
            assertNonEmpty(body.sql, 'SQL text');
            const executed = await postExecute<unknown>(
                projectUuid,
                '/query/sql',
                {
                    sql: body.sql,
                    ...(body.limit !== undefined
                        ? { limit: Math.min(body.limit, config.maxRows) }
                        : {}),
                },
                runOptions?.signal,
            );
            return pollQueryToReady(
                projectUuid,
                parseExecuteResult(executed).queryUuid,
                runOptions,
            );
        },
    };
};
