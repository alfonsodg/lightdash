import { getAgentBiConfig } from '../config/agentBiConfig';
import {
    assertId,
    assertNonEmpty,
    checkHttpStatus,
    parseQueryResult,
    requestJson,
    resolveV2Config,
    scrubBrand,
    throwIfAborted,
    unwrapResults,
} from './lightdashV2Http';
import {
    LightdashV2ClientError,
    type LightdashV2Client,
    type LightdashV2ClientOptions,
    type PollOptions,
    type V2ExecuteResult,
    type V2LifecycleStatus,
    type V2QueryResult,
    type V2ReadyPage,
} from './lightdashV2Types';

export {
    LightdashV2ClientError,
    type FetchImpl,
    type LightdashV2Client,
    type LightdashV2ClientOptions,
    type PollOptions,
    type V2ClientErrorKind,
    type V2ComposeBody,
    type V2ComposeExecuteResult,
    type V2DashboardChartBody,
    type V2ExecuteResult,
    type V2FailedResult,
    type V2FieldValueSearchBody,
    type V2LifecycleStatus,
    type V2MetricQueryBody,
    type V2PendingResult,
    type V2QueryResult,
    type V2ReadyPage,
    type V2ResultRow,
    type V2SavedChartBody,
    type V2SourceQueryStatus,
    type V2SqlBody,
    type V2UnderlyingDataBody,
} from './lightdashV2Types';

export const createLightdashV2Client = (
    options: LightdashV2ClientOptions,
): LightdashV2Client => {
    const config = resolveV2Config(options);

    const effectivePageSize = (pageSize?: number): number => {
        const requested = pageSize ?? getAgentBiConfig().resultsPageSize;
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
