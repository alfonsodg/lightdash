// Contract tests for the typed v2 async query client (Slice B).
//
// No real network: every test injects a fake fetch implementation and a
// manual clock/sleep pair so backoff delays and timeouts are deterministic.

import { describe, expect, it } from 'vitest';
import {
    createLightdashV2Client,
    LightdashV2ClientError,
    type LightdashV2ClientOptions,
} from './lightdashV2Client';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const QUERY_UUID = '22222222-2222-4222-8222-222222222222';

type RecordedRequest = {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
};

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

const readyPage = (overrides: Record<string, unknown> = {}) => ({
    status: 'ready',
    queryUuid: QUERY_UUID,
    columns: {},
    rows: [],
    page: 1,
    pageSize: 10,
    totalPageCount: 1,
    totalResults: 0,
    nextPage: null,
    previousPage: null,
    ...overrides,
});

// Fake fetch backed by a FIFO queue of responders. Each responder sees the
// recorded request and returns the next response.
const queueFetch = (
    recorded: RecordedRequest[],
    responders: Array<(request: RecordedRequest) => Response>,
): LightdashV2ClientOptions['fetchImpl'] => {
    let calls = 0;
    return async (url: unknown, init?: RequestInit): Promise<Response> => {
        const text = typeof init?.body === 'string' ? init.body : undefined;
        const request: RecordedRequest = {
            url: String(url),
            method: init?.method ?? 'GET',
            headers: { ...((init?.headers as Record<string, string>) ?? {}) },
            body: text ? (JSON.parse(text) as unknown) : undefined,
        };
        recorded.push(request);
        const responder = responders[Math.min(calls, responders.length - 1)];
        calls += 1;
        return responder(request);
    };
};

const manualClock = () => {
    let now = 1_000_000;
    const delays: number[] = [];
    return {
        delays,
        now: () => now,
        sleep: async (ms: number): Promise<void> => {
            delays.push(ms);
            now += ms;
        },
    };
};

const clientWith = (
    recorded: RecordedRequest[],
    responders: Array<(request: RecordedRequest) => Response>,
    overrides: Partial<LightdashV2ClientOptions> = {},
) => {
    const clock = manualClock();
    const client = createLightdashV2Client({
        baseUrl: 'https://instance.example',
        headers: { Authorization: 'ApiKey test-token' },
        fetchImpl: queueFetch(recorded, responders),
        nowImpl: clock.now,
        sleepImpl: clock.sleep,
        pollInitialDelayMs: 100,
        pollMaxDelayMs: 10_000,
        pollMaxAttempts: 10,
        ...overrides,
    });
    return { client, clock };
};

describe('execute', () => {
    it('posts a metric query to the v2 route and unwraps the queryUuid', async () => {
        const recorded: RecordedRequest[] = [];
        const { client } = clientWith(recorded, [
            () =>
                jsonResponse({
                    status: 'ok',
                    results: { queryUuid: QUERY_UUID },
                }),
        ]);
        const result = await client.executeMetricQuery(PROJECT_UUID, {
            exploreName: 'orders',
            dimensions: ['orders_status'],
            metrics: ['orders_total'],
        });
        expect(result).toEqual({ queryUuid: QUERY_UUID });
        expect(recorded).toHaveLength(1);
        expect(recorded[0].url).toBe(
            `https://instance.example/api/v2/projects/${PROJECT_UUID}/query/metric-query`,
        );
        expect(recorded[0].method).toBe('POST');
        expect(recorded[0].headers.Authorization).toBe('ApiKey test-token');
        expect(recorded[0].body).toMatchObject({
            query: {
                exploreName: 'orders',
                dimensions: ['orders_status'],
                metrics: ['orders_total'],
            },
        });
    });

    it('posts field-value search with the required table, field and search', async () => {
        const recorded: RecordedRequest[] = [];
        const { client } = clientWith(recorded, [
            () =>
                jsonResponse({
                    status: 'ok',
                    results: { queryUuid: QUERY_UUID },
                }),
        ]);
        await client.executeFieldValueSearch(PROJECT_UUID, {
            table: 'orders',
            fieldId: 'orders_status',
            search: 'pend',
        });
        expect(recorded[0].url.endsWith('/query/field-values')).toBe(true);
        expect(recorded[0].body).toMatchObject({
            table: 'orders',
            fieldId: 'orders_status',
            search: 'pend',
        });
    });

    it('rejects field-value search with a blank table before any request', async () => {
        const recorded: RecordedRequest[] = [];
        const { client } = clientWith(recorded, [
            () => jsonResponse({ status: 'ok', results: {} }),
        ]);
        await expect(
            client.executeFieldValueSearch(PROJECT_UUID, {
                table: '  ',
                fieldId: 'orders_status',
                search: 'pend',
            }),
        ).rejects.toMatchObject({ kind: 'bad_request' });
        expect(recorded).toHaveLength(0);
    });

    it('posts underlying-data with its preceding v2 query reference', async () => {
        const recorded: RecordedRequest[] = [];
        const { client } = clientWith(recorded, [
            () =>
                jsonResponse({
                    status: 'ok',
                    results: { queryUuid: QUERY_UUID },
                }),
        ]);
        await client.executeUnderlyingData(PROJECT_UUID, {
            underlyingDataSourceQueryUuid: QUERY_UUID,
            filters: { and: [] },
        });
        expect(recorded[0].url.endsWith('/query/underlying-data')).toBe(true);
        expect(recorded[0].body).toMatchObject({
            underlyingDataSourceQueryUuid: QUERY_UUID,
        });
    });

    it('posts compose pipelines to query-sources, never ad-hoc SQL', async () => {
        const recorded: RecordedRequest[] = [];
        const { client } = clientWith(recorded, [
            () =>
                jsonResponse({
                    status: 'ok',
                    results: { queries: [{ queryUuid: QUERY_UUID }] },
                }),
        ]);
        const result = await client.executeComposeQueries(PROJECT_UUID, {
            queries: [{ id: 'q1', exploreName: 'orders' }],
        });
        expect(recorded[0].url).toBe(
            `https://instance.example/api/v2/projects/${PROJECT_UUID}/query-sources/queries`,
        );
        expect(result.queries).toHaveLength(1);
    });
});

describe('poll', () => {
    it('polls with deterministic exponential backoff until ready', async () => {
        const recorded: RecordedRequest[] = [];
        const { client, clock } = clientWith(recorded, [
            () =>
                jsonResponse({
                    status: 'ok',
                    results: { queryUuid: QUERY_UUID },
                }),
            () =>
                jsonResponse({
                    status: 'ok',
                    results: { status: 'executing', queryUuid: QUERY_UUID },
                }),
            () =>
                jsonResponse({
                    status: 'ok',
                    results: { status: 'queued', queryUuid: QUERY_UUID },
                }),
            () => jsonResponse({ status: 'ok', results: readyPage() }),
        ]);
        const page = await client.runMetricQuery(
            PROJECT_UUID,
            { exploreName: 'orders' },
            { pageSize: 10 },
        );
        expect(page.status).toBe('ready');
        expect(page.rows).toEqual([]);
        // Deterministic backoff: 100, 200 — no jitter.
        expect(clock.delays).toEqual([100, 200]);
        const pollUrls = recorded
            .filter((request) => request.method === 'GET')
            .map((request) => request.url);
        expect(pollUrls).toHaveLength(3);
        expect(pollUrls[0]).toContain(
            `/query/${QUERY_UUID}?page=1&pageSize=10`,
        );
    });

    it('caps the requested page size at maxRows', async () => {
        const recorded: RecordedRequest[] = [];
        const { client } = clientWith(
            recorded,
            [() => jsonResponse({ status: 'ok', results: readyPage() })],
            { maxRows: 25 },
        );
        await client.getQueryResults(PROJECT_UUID, QUERY_UUID, {
            pageSize: 5000,
        });
        expect(recorded[0].url).toContain('pageSize=25');
    });

    it('surfaces query failure and expiry as typed errors', async () => {
        const recorded: RecordedRequest[] = [];
        const { client } = clientWith(recorded, [
            () =>
                jsonResponse({
                    status: 'ok',
                    results: {
                        status: 'error',
                        queryUuid: QUERY_UUID,
                        error: 'warehouse boom',
                    },
                }),
        ]);
        await expect(
            client.pollQueryToReady(PROJECT_UUID, QUERY_UUID),
        ).rejects.toMatchObject({ kind: 'query_error' });

        const recordedExpired: RecordedRequest[] = [];
        const expired = clientWith(recordedExpired, [
            () =>
                jsonResponse({
                    status: 'ok',
                    results: {
                        status: 'expired',
                        queryUuid: QUERY_UUID,
                        error: null,
                    },
                }),
        ]);
        await expect(
            expired.client.pollQueryToReady(PROJECT_UUID, QUERY_UUID),
        ).rejects.toMatchObject({ kind: 'query_expired' });
    });

    it('times out when the query never leaves the queue', async () => {
        const recorded: RecordedRequest[] = [];
        const { client } = clientWith(
            recorded,
            [
                () =>
                    jsonResponse({
                        status: 'ok',
                        results: {
                            status: 'queued',
                            queryUuid: QUERY_UUID,
                        },
                    }),
            ],
            { pollMaxAttempts: 100 },
        );
        await expect(
            client.pollQueryToReady(PROJECT_UUID, QUERY_UUID, {
                timeoutMs: 250,
            }),
        ).rejects.toMatchObject({ kind: 'timeout' });
    });

    it('aborts polling and best-effort cancels the server query', async () => {
        const recorded: RecordedRequest[] = [];
        const controller = new AbortController();
        const clock = manualClock();
        const client = createLightdashV2Client({
            baseUrl: 'https://instance.example',
            fetchImpl: queueFetch(recorded, [
                () =>
                    jsonResponse({
                        status: 'ok',
                        results: {
                            status: 'executing',
                            queryUuid: QUERY_UUID,
                        },
                    }),
                () => jsonResponse({ status: 'ok', results: undefined }),
            ]),
            nowImpl: clock.now,
            sleepImpl: async () => {
                controller.abort();
            },
        });
        await expect(
            client.pollQueryToReady(PROJECT_UUID, QUERY_UUID, {
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ kind: 'aborted' });
        expect(
            recorded.some(
                (request) =>
                    request.method === 'POST' &&
                    request.url.endsWith(`/query/${QUERY_UUID}/cancel`),
            ),
        ).toBe(true);
    });
});

describe('http errors', () => {
    const statusKind: Array<[number, string]> = [
        [401, 'unauthorized'],
        [403, 'forbidden'],
        [404, 'not_found'],
        [500, 'server'],
        [503, 'server'],
    ];
    it.each(statusKind)(
        'maps HTTP %i to %s without brand or secret leakage',
        async (status, kind) => {
            const recorded: RecordedRequest[] = [];
            const { client } = clientWith(recorded, [
                () => jsonResponse({ status: 'error' }, status),
            ]);
            const failure = await client
                .executeMetricQuery(PROJECT_UUID, {
                    exploreName: 'orders',
                })
                .then(
                    () => null,
                    (error: unknown) => error,
                );
            expect(failure).toBeInstanceOf(LightdashV2ClientError);
            expect(failure).toMatchObject({ kind, status });
            const { message } = failure as LightdashV2ClientError;
            expect(message).not.toMatch(/lightdash/i);
            expect(message).not.toContain('test-token');
        },
    );

    it('scrubs brand text out of server-reported query errors', async () => {
        const recorded: RecordedRequest[] = [];
        const { client } = clientWith(recorded, [
            () =>
                jsonResponse({
                    status: 'ok',
                    results: {
                        status: 'error',
                        queryUuid: QUERY_UUID,
                        error: 'Lightdash warehouse exploded',
                    },
                }),
        ]);
        const failure = await client
            .pollQueryToReady(PROJECT_UUID, QUERY_UUID)
            .then(
                () => null,
                (error: unknown) => error,
            );
        expect(failure).toMatchObject({ kind: 'query_error' });
        expect((failure as LightdashV2ClientError).message).not.toMatch(
            /lightdash/i,
        );
    });
});
