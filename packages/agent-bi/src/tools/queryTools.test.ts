// Unit tests for the governed query tools (Slice C).
//
// The Slice B client is faked: execute* calls record their request shapes
// and polling resolves from canned pages. No real network, no warehouse.

import { describe, expect, it } from 'vitest';
import type { AuditQueryClient } from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import type { V2ReadyPage } from '../client/lightdashV2Client';
import { defaultCapabilityToggles } from '../policy/capabilityPolicy';
import {
    AgentToolError,
    createQueryTools,
    type QueryToolDeps,
    type QueryToolsClient,
} from './queryTools';

const PROJECT_UUID = '22222222-2222-4222-8222-222222222222';
const QUERY_UUID = '33333333-3333-4333-8333-333333333333';
const SOURCE_QUERY_UUID = '44444444-4444-4434-8444-444444444444';
const CHART_UUID = '55555555-5555-4555-8555-555555555555';

const allowAllPrincipal = (): AgentPrincipal => ({
    ability: { can: () => true },
    authType: 'session',
    cacheKey: 'test-cache-key',
    organizationUuid: 'org-1',
    userAttributesHash: 'abcd1234',
    userUuid: '11111111-1111-4111-8111-111111111111',
});

const denyAllPrincipal = (): AgentPrincipal => ({
    ...allowAllPrincipal(),
    ability: { can: () => false },
});

const recordedAudits: Array<{ text: string; params: unknown[] }> = [];

const auditClient: AuditQueryClient = {
    query: async (text: string, params?: unknown[]): Promise<unknown> => {
        recordedAudits.push({ params: params ?? [], text });
        return undefined;
    },
};

const auditMetadataOf = (index: number): Record<string, unknown> => {
    const params = recordedAudits[index]?.params as unknown[];
    return JSON.parse(params[4] as string) as Record<string, unknown>;
};

const readyPage = (queryUuid: string = QUERY_UUID): V2ReadyPage => ({
    columns: { orders_status: { type: 'string' } },
    nextPage: null,
    page: 1,
    pageSize: 10,
    previousPage: null,
    queryUuid,
    rows: [{ orders_status: 'pending' }],
    status: 'ready',
    totalPageCount: 1,
    totalResults: 1,
});

const setup = (overrides: Partial<QueryToolDeps> = {}) => {
    const calls: Array<{ body: unknown; method: string; projectUuid: string }> =
        [];
    const polls: string[] = [];
    const queryClient: QueryToolsClient = {
        executeComposeQueries: async (projectUuid, body) => {
            calls.push({
                body,
                method: 'executeComposeQueries',
                projectUuid,
            });
            return {
                queries: (body.queries as unknown[]).map((_, index) => ({
                    queryUuid: `${QUERY_UUID.slice(0, 30)}${index}00`,
                })),
            };
        },
        executeDashboardChart: async (projectUuid, body) => {
            calls.push({
                body,
                method: 'executeDashboardChart',
                projectUuid,
            });
            return { queryUuid: QUERY_UUID };
        },
        executeSavedChart: async (projectUuid, body) => {
            calls.push({ body, method: 'executeSavedChart', projectUuid });
            return { queryUuid: QUERY_UUID };
        },
        executeUnderlyingData: async (projectUuid, body) => {
            calls.push({
                body,
                method: 'executeUnderlyingData',
                projectUuid,
            });
            return { queryUuid: QUERY_UUID };
        },
        pollQueryToReady: async (_projectUuid, queryUuid) => {
            polls.push(queryUuid);
            return readyPage(queryUuid);
        },
        runMetricQuery: async (projectUuid, query) => {
            calls.push({
                body: query,
                method: 'runMetricQuery',
                projectUuid,
            });
            return readyPage();
        },
        runSqlQuery: async (projectUuid, body) => {
            calls.push({ body, method: 'runSqlQuery', projectUuid });
            return readyPage();
        },
    };
    const tools = createQueryTools({
        auditClient,
        policyContext: { toggles: defaultCapabilityToggles() },
        queryClient,
        rawSql: { readOnlyEnforced: true },
        ...overrides,
    });
    return { calls, polls, tools };
};

describe('run_metric_query', () => {
    it('runs a metric query through the v2 client and audits the allow', async () => {
        recordedAudits.length = 0;
        const { calls, tools } = setup();
        const result = (await tools.executeTool(
            'run_metric_query',
            {
                dimensions: ['orders_status'],
                exploreName: 'orders',
                projectUuid: PROJECT_UUID,
            },
            allowAllPrincipal(),
        )) as V2ReadyPage;
        expect(result.status).toBe('ready');
        expect(result.rows).toHaveLength(1);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe('runMetricQuery');
        expect(calls[0]?.body).toMatchObject({
            dimensions: ['orders_status'],
            exploreName: 'orders',
        });
        expect(recordedAudits).toHaveLength(1);
        expect(auditMetadataOf(0)).toMatchObject({
            tool: 'run_metric_query',
            verdict: 'allow',
        });
    });

    it('requires dimensions or metrics', async () => {
        const { tools } = setup();
        const error = await tools
            .executeTool(
                'run_metric_query',
                { exploreName: 'orders', projectUuid: PROJECT_UUID },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('INVALID_INPUT');
    });

    it('denies a viewer-like principal and audits the deny', async () => {
        recordedAudits.length = 0;
        const { calls, tools } = setup();
        const error = await tools
            .executeTool(
                'run_metric_query',
                {
                    exploreName: 'orders',
                    metrics: ['orders_total'],
                    projectUuid: PROJECT_UUID,
                },
                denyAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('POLICY_DENIED');
        expect(calls).toHaveLength(0);
        expect(recordedAudits).toHaveLength(1);
        expect(auditMetadataOf(0)).toMatchObject({
            policyReason: 'INSUFFICIENT_PERMISSIONS',
            verdict: 'deny',
        });
    });
});

describe('run_saved_chart', () => {
    it('executes a saved chart then polls the ready page', async () => {
        const { calls, polls, tools } = setup();
        const result = (await tools.executeTool(
            'run_saved_chart',
            { chartUuid: CHART_UUID, projectUuid: PROJECT_UUID },
            allowAllPrincipal(),
        )) as V2ReadyPage;
        expect(result.status).toBe('ready');
        expect(calls[0]?.method).toBe('executeSavedChart');
        expect(calls[0]?.body).toMatchObject({ chartUuid: CHART_UUID });
        expect(polls).toEqual([QUERY_UUID]);
    });

    it('routes dashboard tiles through the dashboard-chart endpoint', async () => {
        const { calls, tools } = setup();
        await tools.executeTool(
            'run_saved_chart',
            {
                chartUuid: CHART_UUID,
                dashboardUuid: PROJECT_UUID,
                projectUuid: PROJECT_UUID,
                tileUuid: 'tile-1',
            },
            allowAllPrincipal(),
        );
        expect(calls[0]?.method).toBe('executeDashboardChart');
        expect(calls[0]?.body).toMatchObject({
            dashboardUuid: PROJECT_UUID,
            tileUuid: 'tile-1',
        });
    });

    it('requires a tile for dashboard chart execution', async () => {
        const { tools } = setup();
        const error = await tools
            .executeTool(
                'run_saved_chart',
                {
                    chartUuid: CHART_UUID,
                    dashboardUuid: PROJECT_UUID,
                    projectUuid: PROJECT_UUID,
                },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('INVALID_INPUT');
    });
});

describe('run_underlying_data', () => {
    it('needs a preceding v2 query reference and filters', async () => {
        const { calls, tools } = setup();
        const missing = await tools
            .executeTool(
                'run_underlying_data',
                { filters: {}, projectUuid: PROJECT_UUID },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(missing).toBeInstanceOf(AgentToolError);
        expect((missing as AgentToolError).code).toBe('INVALID_INPUT');

        const result = (await tools.executeTool(
            'run_underlying_data',
            {
                filters: { equals: [] },
                projectUuid: PROJECT_UUID,
                underlyingDataSourceQueryUuid: SOURCE_QUERY_UUID,
            },
            allowAllPrincipal(),
        )) as V2ReadyPage;
        expect(result.status).toBe('ready');
        expect(calls[0]?.method).toBe('executeUnderlyingData');
        expect(calls[0]?.body).toMatchObject({
            underlyingDataSourceQueryUuid: SOURCE_QUERY_UUID,
        });
    });
});

describe('run_compose_pipeline', () => {
    it('rejects an empty pipeline and polls every submitted query', async () => {
        const { polls, tools } = setup();
        const empty = await tools
            .executeTool(
                'run_compose_pipeline',
                { projectUuid: PROJECT_UUID, queries: [] },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(empty).toBeInstanceOf(AgentToolError);
        expect((empty as AgentToolError).code).toBe('INVALID_INPUT');

        const result = (await tools.executeTool(
            'run_compose_pipeline',
            {
                projectUuid: PROJECT_UUID,
                queries: [{ nodeA: true }, { nodeB: true }],
            },
            allowAllPrincipal(),
        )) as { pages: V2ReadyPage[] };
        expect(result.pages).toHaveLength(2);
        expect(polls).toHaveLength(2);
        for (const page of result.pages) {
            expect(page.status).toBe('ready');
        }
    });

    it('bounds the pipeline fan-out per call', async () => {
        const { tools } = setup({ composeMaxQueries: 1 });
        const error = await tools
            .executeTool(
                'run_compose_pipeline',
                {
                    projectUuid: PROJECT_UUID,
                    queries: [{ nodeA: true }, { nodeB: true }],
                },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('INVALID_INPUT');
    });
});

describe('run_sql', () => {
    it('stays denied while the raw_sql capability toggle is off', async () => {
        recordedAudits.length = 0;
        const { calls, tools } = setup();
        const error = await tools
            .executeTool(
                'run_sql',
                {
                    approvalToken: 'human-yes',
                    projectUuid: PROJECT_UUID,
                    sql: 'SELECT status FROM orders',
                },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('POLICY_DENIED');
        expect(calls).toHaveLength(0);
        expect(auditMetadataOf(0).verdict).toBe('deny');
    });

    it('denies destructive SQL through the guard and audits the guard reason', async () => {
        recordedAudits.length = 0;
        const { calls, tools } = setup({
            policyContext: {
                toggles: { ...defaultCapabilityToggles(), raw_sql: true },
            },
        });
        const error = await tools
            .executeTool(
                'run_sql',
                {
                    approvalToken: 'human-yes',
                    projectUuid: PROJECT_UUID,
                    sql: 'DROP TABLE orders',
                },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('GUARD_DENIED');
        expect(calls).toHaveLength(0);
        expect(recordedAudits).toHaveLength(1);
        expect(auditMetadataOf(0)).toMatchObject({
            tool: 'run_sql',
            verdict: 'deny',
        });
        expect(auditMetadataOf(0).guardReason).toBeTruthy();
    });

    it('denies reads without a read-only attestation', async () => {
        const { tools } = setup({
            policyContext: {
                toggles: { ...defaultCapabilityToggles(), raw_sql: true },
            },
            rawSql: { readOnlyEnforced: false },
        });
        const error = await tools
            .executeTool(
                'run_sql',
                {
                    approvalToken: 'human-yes',
                    projectUuid: PROJECT_UUID,
                    sql: 'SELECT status FROM orders',
                },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('GUARD_DENIED');
        expect((error as AgentToolError).reason).toBe('READ_ONLY_UNVERIFIED');
    });

    it('requires human approval for every execution', async () => {
        const { tools } = setup({
            policyContext: {
                toggles: { ...defaultCapabilityToggles(), raw_sql: true },
            },
        });
        const error = await tools
            .executeTool(
                'run_sql',
                { projectUuid: PROJECT_UUID, sql: 'SELECT status FROM orders' },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('GUARD_DENIED');
        expect((error as AgentToolError).reason).toBe('MISSING_APPROVAL');
    });

    it('runs an approved read-only select through the wrapped query', async () => {
        const { calls, tools } = setup({
            policyContext: {
                toggles: { ...defaultCapabilityToggles(), raw_sql: true },
            },
        });
        const result = (await tools.executeTool(
            'run_sql',
            {
                approvalToken: 'human-yes',
                projectUuid: PROJECT_UUID,
                sql: 'SELECT status FROM orders',
            },
            allowAllPrincipal(),
        )) as V2ReadyPage;
        expect(result.status).toBe('ready');
        expect(calls).toHaveLength(1);
        const body = calls[0]?.body as { sql: string };
        expect(body.sql).toContain('agent_bi_read_only');
        expect(body.sql).toContain('SELECT status FROM orders');
    });
});

describe('query tool registry', () => {
    it('rejects unknown tools and keeps messages white-label', async () => {
        const { tools } = setup();
        const error = await tools
            .executeTool(
                'run_everything',
                { projectUuid: PROJECT_UUID },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('UNKNOWN_TOOL');
        expect(
            String((error as AgentToolError).message).toLowerCase(),
        ).not.toContain('lightdash');
    });
});
