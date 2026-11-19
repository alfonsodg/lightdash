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

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface LightdashV2ClientOptions {
    baseUrl: string;
    headers?: Record<string, string>;
    fetchImpl?: FetchImpl;
    maxRows?: number;
    timeoutMs?: number;
    pollInitialDelayMs?: number;
    pollMaxDelayMs?: number;
    pollMaxAttempts?: number;
    sleepImpl?: (ms: number) => Promise<void>;
    nowImpl?: () => number;
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
