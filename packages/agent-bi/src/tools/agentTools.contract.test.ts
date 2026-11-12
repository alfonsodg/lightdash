// Cross-module contract tests (Slice D): tool executor against the real
// catalog indexer shapes and the Slice B client seam. Fakes only at the
// HTTP boundary; no live server, no database.

import { describe, expect, it } from 'vitest';
import type { AuditQueryClient } from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import {
    buildCatalogDocuments,
    searchCatalogDocuments,
    type CatalogVisibility,
} from '../catalog/catalogIndexer';
import type { V2ReadyPage } from '../client/lightdashV2Client';
import { defaultCapabilityToggles } from '../policy/capabilityPolicy';
import {
    AgentToolError,
    createAgentTools,
    type AgentToolsDeps,
    type DiscoveryFetchRequest,
} from './index';

const PROJECT_UUID = '22222222-2222-4222-8222-222222222222';
const QUERY_UUID = '33333333-3333-4333-8333-333333333333';
const CHART_UUID = '55555555-5555-4555-8555-555555555555';

const viewer = (): AgentPrincipal => ({
    ability: { can: () => false },
    authType: 'session',
    cacheKey: 'contract-viewer',
    organizationUuid: 'org-1',
    userAttributesHash: 'abcd1234',
    userUuid: '11111111-1111-4111-8111-111111111111',
});

const interactiveViewer = (): AgentPrincipal => ({
    ability: {
        can: (action: string, subject: string) =>
            action === 'view' &&
            (subject === 'Project' || subject === 'Explore'),
    },
    authType: 'session',
    cacheKey: 'contract-interactive-viewer',
    organizationUuid: 'org-1',
    userAttributesHash: 'abcd1234',
    userUuid: '22222222-2222-4222-8222-222222222222',
});

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

const setup = (responses: Record<string, unknown> = {}) => {
    const recordedPaths: DiscoveryFetchRequest[] = [];
    const recordedCalls: Array<{ body: unknown; method: string }> = [];
    const recordedPolls: string[] = [];
    const recordedAudits: Array<{ text: string; params: unknown[] }> = [];
    const auditClient: AuditQueryClient = {
        query: async (text: string, params?: unknown[]) => {
            recordedAudits.push({ params: params ?? [], text });
            return undefined;
        },
    };
    const indexed = buildCatalogDocuments(PROJECT_UUID, [
        {
            baseTable: 'orders',
            description: 'Shop orders',
            label: 'Orders',
            name: 'orders',
            tables: {
                orders: {
                    dimensions: {
                        status: {
                            description: 'Order status',
                            label: 'Status',
                            name: 'status',
                            type: 'string',
                        },
                    },
                    label: 'Orders',
                    metrics: {
                        total: {
                            description: 'Order count',
                            label: 'Total',
                            name: 'total',
                            type: 'count',
                        },
                    },
                    name: 'orders',
                },
            },
        },
    ]);
    const deps: AgentToolsDeps = {
        auditClient,
        catalogSearch: {
            search: (query: string, visibility: CatalogVisibility) =>
                searchCatalogDocuments(indexed, query, visibility),
        },
        discoveryFetch: async (request: DiscoveryFetchRequest) => {
            recordedPaths.push(request);
            if (!(request.path in responses)) {
                throw new Error(`Unexpected discovery path: ${request.path}`);
            }
            return responses[request.path];
        },
        fieldValuesClient: {
            executeFieldValueSearch: async () => ({ queryUuid: QUERY_UUID }),
            pollQueryToReady: async (_projectUuid, queryUuid) => {
                recordedPolls.push(queryUuid);
                return readyPage(queryUuid);
            },
        },
        policyContext: { toggles: defaultCapabilityToggles() },
        queryClient: {
            executeComposeQueries: async (_projectUuid, body) => {
                recordedCalls.push({
                    body,
                    method: 'executeComposeQueries',
                });
                return {
                    queries: (body.queries as unknown[]).map((_, index) => ({
                        queryUuid: `${QUERY_UUID.slice(0, 30)}${index}00`,
                    })),
                };
            },
            executeDashboardChart: async (_projectUuid, body) => {
                recordedCalls.push({ body, method: 'executeDashboardChart' });
                return { queryUuid: QUERY_UUID };
            },
            executeSavedChart: async (_projectUuid, body) => {
                recordedCalls.push({ body, method: 'executeSavedChart' });
                return { queryUuid: QUERY_UUID };
            },
            executeUnderlyingData: async (_projectUuid, body) => {
                recordedCalls.push({ body, method: 'executeUnderlyingData' });
                return { queryUuid: QUERY_UUID };
            },
            pollQueryToReady: async (_projectUuid, queryUuid) => {
                recordedPolls.push(queryUuid);
                return readyPage(queryUuid);
            },
            runMetricQuery: async (_projectUuid, query) => {
                recordedCalls.push({ body: query, method: 'runMetricQuery' });
                return readyPage();
            },
            runSqlQuery: async (_projectUuid, body) => {
                recordedCalls.push({ body, method: 'runSqlQuery' });
                return readyPage();
            },
        },
        rawSql: { readOnlyEnforced: true },
    };
    const tools = createAgentTools(deps);
    return {
        recordedAudits,
        recordedCalls,
        recordedPaths,
        recordedPolls,
        tools,
    };
};

const auditVerdicts = (
    recordedAudits: Array<{ params: unknown[] }>,
): unknown[] =>
    recordedAudits.map((row) => JSON.parse(row.params[4] as string) as unknown);

describe('tool to client request shapes', () => {
    it('maps run_metric_query input onto the v2 metric-query body', async () => {
        const { recordedCalls, tools } = setup();
        const result = (await tools.executeTool(
            'run_metric_query',
            {
                dimensions: ['orders_status'],
                exploreName: 'orders',
                metrics: ['orders_total'],
                projectUuid: PROJECT_UUID,
                sorts: [{ descending: true, fieldId: 'orders_status' }],
            },
            interactiveViewer(),
        )) as V2ReadyPage;
        expect(result.status).toBe('ready');
        expect(recordedCalls).toHaveLength(1);
        expect(recordedCalls[0]).toMatchObject({
            body: {
                dimensions: ['orders_status'],
                exploreName: 'orders',
                metrics: ['orders_total'],
            },
            method: 'runMetricQuery',
        });
    });

    it('routes dashboard tiles through the dashboard-chart endpoint', async () => {
        const { recordedCalls, recordedPolls, tools } = setup();
        await tools.executeTool(
            'run_saved_chart',
            {
                chartUuid: CHART_UUID,
                dashboardUuid: PROJECT_UUID,
                projectUuid: PROJECT_UUID,
                tileUuid: 'tile-1',
            },
            interactiveViewer(),
        );
        expect(recordedCalls[0]?.method).toBe('executeDashboardChart');
        expect(recordedCalls[0]?.body).toMatchObject({
            chartUuid: CHART_UUID,
            dashboardUuid: PROJECT_UUID,
            tileUuid: 'tile-1',
        });
        expect(recordedPolls).toEqual([QUERY_UUID]);
    });

    it('fans compose pipelines out and polls every submitted query', async () => {
        const { recordedCalls, recordedPolls, tools } = setup();
        const result = (await tools.executeTool(
            'run_compose_pipeline',
            {
                projectUuid: PROJECT_UUID,
                queries: [{ nodeA: true }, { nodeB: true }],
            },
            interactiveViewer(),
        )) as { pages: V2ReadyPage[] };
        expect(result.pages).toHaveLength(2);
        expect(recordedCalls).toHaveLength(1);
        expect(recordedPolls).toHaveLength(2);
    });

    it('searches the real indexed catalog gated by caller visibility', async () => {
        const { tools } = setup();
        const allowed = (await tools.executeTool(
            'search_catalog_fields',
            { projectUuid: PROJECT_UUID, query: 'status' },
            interactiveViewer(),
            {
                visibility: {
                    allowedExplores: new Set(['orders']),
                },
            },
        )) as { hits: Array<{ exploreName: string }> };
        expect(allowed.hits.length).toBeGreaterThan(0);
        for (const hit of allowed.hits) {
            expect(hit.exploreName).toBe('orders');
        }
        const denied = (await tools.executeTool(
            'search_catalog_fields',
            { projectUuid: PROJECT_UUID, query: 'status' },
            interactiveViewer(),
            { visibility: { allowedExplores: new Set(['payments']) } },
        )) as { hits: unknown[] };
        expect(denied.hits).toHaveLength(0);
    });
});

describe('viewer versus interactive viewer', () => {
    it('denies a plain viewer without touching the client', async () => {
        const { recordedAudits, recordedCalls, tools } = setup();
        const error = await tools
            .executeTool(
                'run_metric_query',
                {
                    dimensions: ['orders_status'],
                    exploreName: 'orders',
                    projectUuid: PROJECT_UUID,
                },
                viewer(),
            )
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('POLICY_DENIED');
        expect(recordedCalls).toHaveLength(0);
        expect(auditVerdicts(recordedAudits)).toMatchObject([
            { tool: 'run_metric_query', verdict: 'deny' },
        ]);
    });

    it('allows an interactive viewer through to the ready page', async () => {
        const { recordedCalls, tools } = setup();
        const result = (await tools.executeTool(
            'run_metric_query',
            {
                exploreName: 'orders',
                metrics: ['orders_total'],
                projectUuid: PROJECT_UUID,
            },
            interactiveViewer(),
        )) as V2ReadyPage;
        expect(result.status).toBe('ready');
        expect(recordedCalls).toHaveLength(1);
    });
});

describe('agent tool registry contract', () => {
    it('rejects unknown tools with UNKNOWN_TOOL', async () => {
        const { tools } = setup();
        const error = await tools
            .executeTool(
                'run_everything',
                { projectUuid: PROJECT_UUID },
                interactiveViewer(),
            )
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('UNKNOWN_TOOL');
    });

    it('requires table on field-values search and schema names on warehouse inspection', async () => {
        const { tools } = setup();
        const principal = interactiveViewer();
        const missingTable = await tools
            .executeTool(
                'search_field_values',
                {
                    fieldId: 'orders_status',
                    projectUuid: PROJECT_UUID,
                    search: 'pend',
                },
                principal,
            )
            .catch((caught: unknown) => caught);
        expect((missingTable as AgentToolError).code).toBe('INVALID_INPUT');
        const missingSchema = await tools
            .executeTool(
                'inspect_warehouse_columns',
                { projectUuid: PROJECT_UUID, tableName: 'orders' },
                principal,
            )
            .catch((caught: unknown) => caught);
        expect((missingSchema as AgentToolError).code).toBe('INVALID_INPUT');
    });

    it('never records a deprecated v1 route', async () => {
        const projectPath = (name: string): string =>
            `/api/v1/projects/${PROJECT_UUID}/${name}`;
        const { recordedPaths, tools } = setup({
            [projectPath('explores')]: { results: [] },
            [projectPath('explores/orders')]: {
                results: { name: 'orders', tables: {} },
            },
            [projectPath('dataCatalog/metrics/orders/total')]: { results: {} },
            [projectPath('sqlRunner/fields')]: { results: {} },
            '/api/v2/content': { results: [] },
        });
        const principal = interactiveViewer();
        await tools.executeTool(
            'list_explores',
            { projectUuid: PROJECT_UUID },
            principal,
        );
        await tools.executeTool(
            'get_explore',
            { exploreId: 'orders', projectUuid: PROJECT_UUID },
            principal,
        );
        await tools.executeTool(
            'list_spaces_and_content',
            { projectUuid: PROJECT_UUID },
            principal,
        );
        const deprecated = [
            'runQuery',
            'runUnderlyingDataQuery',
            '/saved/',
            'sqlRunner/run',
            'sqlRunner/runPivotQuery',
            '/results',
            '/metadata',
            '/download',
        ];
        for (const request of recordedPaths) {
            for (const marker of deprecated) {
                expect(request.path).not.toContain(marker);
            }
        }
    });

    it('keeps errors white-label and secrets out of audit rows', async () => {
        const { recordedAudits, tools } = setup();
        const token = ['ldpat', 'sample-test-token'].join('_');
        await tools.executeTool(
            'search_field_values',
            {
                fieldId: 'orders_status',
                filters: { session_token: token },
                projectUuid: PROJECT_UUID,
                search: 'pend',
                table: 'orders',
            },
            interactiveViewer(),
        );
        expect(JSON.stringify(recordedAudits)).not.toContain(
            'sample-test-token',
        );
        const error = await tools
            .executeTool(
                'list_explores',
                { projectUuid: 'not-a-uuid' },
                interactiveViewer(),
            )
            .catch((caught: unknown) => caught);
        expect(
            String((error as AgentToolError).message).toLowerCase(),
        ).not.toContain('lightdash');
    });
});
