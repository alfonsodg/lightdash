// Unit tests for the discovery tools (Slice C).
//
// No real network, no live index: a fake DiscoveryFetch records request
// paths, a fake catalog searcher stands in for Slice A, and a fake
// field-values client stands in for Slice B polling.

import { describe, expect, it } from 'vitest';
import type { AuditQueryClient } from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import type {
    CatalogSearchHit,
    CatalogVisibility,
} from '../catalog/catalogIndexer';
import type { V2ReadyPage } from '../client/lightdashV2Client';
import { defaultCapabilityToggles } from '../policy/capabilityPolicy';
import {
    AgentToolError,
    createDiscoveryTools,
    type DiscoveryFetch,
    type DiscoveryFetchRequest,
    type DiscoveryToolDeps,
} from './discoveryTools';

const PROJECT_UUID = '22222222-2222-4222-8222-222222222222';
const QUERY_UUID = '33333333-3333-4333-8333-333333333333';

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

const readyPage = () => ({
    columns: {},
    nextPage: null,
    page: 1,
    pageSize: 10,
    previousPage: null,
    queryUuid: QUERY_UUID,
    rows: [{ orders_status: 'pending' }],
    status: 'ready',
    totalPageCount: 1,
    totalResults: 1,
});

const visibilityWith = (...explores: string[]): CatalogVisibility => ({
    allowedExplores: new Set(explores),
});

const catalogHit = (exploreName: string, score = 3): CatalogSearchHit => ({
    document: {
        content: `dimension orders.${exploreName} in explore ${exploreName}`,
        contentHash: 'hash',
        embedding: null,
        exploreName,
        fieldKind: 'dimension',
        fieldName: 'status',
        projectUuid: PROJECT_UUID,
        resourceType: 'dimension',
        resourceUuid: `${exploreName}-uuid`,
        tableName: 'orders',
    },
    score,
});

const setup = (
    responses: Record<string, unknown>,
    recorded: DiscoveryFetchRequest[],
    overrides: Partial<DiscoveryToolDeps> = {},
) => {
    const discoveryFetch: DiscoveryFetch = async (
        request: DiscoveryFetchRequest,
    ) => {
        recorded.push(request);
        const key = request.path;
        if (!(key in responses)) {
            throw new Error(`Unexpected discovery path: ${key}`);
        }
        return responses[key];
    };
    const fieldCalls: Array<{ body: unknown; projectUuid: string }> = [];
    const catalogCalls: Array<{ projectUuid: string | undefined }> = [];
    const pollCalls: string[] = [];
    const tools = createDiscoveryTools({
        auditClient,
        catalogSearch: {
            search: (
                _query: string,
                visibility: CatalogVisibility,
                _limit: number,
                projectUuid?: string,
            ) => {
                catalogCalls.push({ projectUuid });
                return [catalogHit('orders'), catalogHit('payments')].filter(
                    (hit) =>
                        visibility.allowedExplores.has(
                            hit.document.exploreName,
                        ),
                );
            },
        },
        discoveryFetch,
        fieldValuesClient: {
            executeFieldValueSearch: async (projectUuid, body) => {
                fieldCalls.push({ body, projectUuid });
                return { queryUuid: QUERY_UUID };
            },
            pollQueryToReady: async (_projectUuid, queryUuid) => {
                pollCalls.push(queryUuid);
                return readyPage() as unknown as V2ReadyPage;
            },
        },
        policyContext: { toggles: defaultCapabilityToggles() },
        ...overrides,
    });
    return { catalogCalls, fieldCalls, pollCalls, tools };
};

describe('list_explores', () => {
    it('calls the v1 explores list endpoint and audits the allow', async () => {
        recordedAudits.length = 0;
        const recorded: DiscoveryFetchRequest[] = [];
        const { tools } = setup(
            {
                [`/api/v1/projects/${PROJECT_UUID}/explores`]: {
                    results: [
                        {
                            description: 'Shop orders',
                            label: 'Orders',
                            name: 'orders',
                            tags: ['marts'],
                        },
                    ],
                    status: 'ok',
                },
            },
            recorded,
        );
        const result = await tools.executeTool(
            'list_explores',
            { projectUuid: PROJECT_UUID },
            allowAllPrincipal(),
        );
        expect(result).toEqual({
            explores: [
                {
                    description: 'Shop orders',
                    label: 'Orders',
                    name: 'orders',
                    tags: ['marts'],
                },
            ],
        });
        expect(recorded).toHaveLength(1);
        expect(recorded[0]?.path).toBe(
            `/api/v1/projects/${PROJECT_UUID}/explores`,
        );
        expect(recordedAudits).toHaveLength(1);
        expect(auditMetadataOf(0).verdict).toBe('allow');
        expect(auditMetadataOf(0).tool).toBe('list_explores');
    });

    it('denies a principal without discover permission and audits the deny', async () => {
        recordedAudits.length = 0;
        const recorded: DiscoveryFetchRequest[] = [];
        const { tools } = setup({}, recorded);
        const error = await tools
            .executeTool(
                'list_explores',
                { projectUuid: PROJECT_UUID },
                denyAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('POLICY_DENIED');
        expect(recorded).toHaveLength(0);
        expect(recordedAudits).toHaveLength(1);
        expect(auditMetadataOf(0).verdict).toBe('deny');
        expect(auditMetadataOf(0).policyReason).toBe(
            'INSUFFICIENT_PERMISSIONS',
        );
    });
});

describe('get_explore', () => {
    it('fetches a single explore and normalizes table names', async () => {
        const recorded: DiscoveryFetchRequest[] = [];
        const { tools } = setup(
            {
                [`/api/v1/projects/${PROJECT_UUID}/explores/orders`]: {
                    results: {
                        baseTable: 'orders',
                        description: null,
                        label: 'Orders',
                        name: 'orders',
                        tables: {
                            orders: {},
                            payments: {},
                        },
                    },
                    status: 'ok',
                },
            },
            recorded,
        );
        const result = await tools.executeTool(
            'get_explore',
            { exploreId: 'orders', projectUuid: PROJECT_UUID },
            allowAllPrincipal(),
        );
        expect(result).toEqual({
            explore: {
                baseTable: 'orders',
                description: null,
                label: 'Orders',
                name: 'orders',
                tables: ['orders', 'payments'],
            },
        });
    });

    it('rejects a blank explore id', async () => {
        const recorded: DiscoveryFetchRequest[] = [];
        const { tools } = setup({}, recorded);
        const error = await tools
            .executeTool(
                'get_explore',
                { exploreId: '   ', projectUuid: PROJECT_UUID },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('INVALID_INPUT');
    });
});

describe('search_catalog_fields', () => {
    it('passes the requested project to catalog search', async () => {
        const recorded: DiscoveryFetchRequest[] = [];
        const { catalogCalls, tools } = setup({}, recorded);
        await tools.executeTool(
            'search_catalog_fields',
            { projectUuid: PROJECT_UUID, query: 'status' },
            allowAllPrincipal(),
            { visibility: visibilityWith('orders') },
        );

        expect(catalogCalls[0]?.projectUuid).toBe(PROJECT_UUID);
    });

    it('filters hits through the caller visibility lists', async () => {
        const recorded: DiscoveryFetchRequest[] = [];
        const { tools } = setup({}, recorded);
        const result = (await tools.executeTool(
            'search_catalog_fields',
            { projectUuid: PROJECT_UUID, query: 'status' },
            allowAllPrincipal(),
            { visibility: visibilityWith('orders') },
        )) as { hits: Array<{ exploreName: string }> };
        expect(result.hits).toHaveLength(1);
        expect(result.hits[0]?.exploreName).toBe('orders');
    });

    it('requires visibility lists before searching', async () => {
        const recorded: DiscoveryFetchRequest[] = [];
        const { tools } = setup({}, recorded);
        const error = await tools
            .executeTool(
                'search_catalog_fields',
                { projectUuid: PROJECT_UUID, query: 'status' },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('INVALID_INPUT');
    });
});

describe('search_field_values', () => {
    it('requires the explore table and polls the v2 field-values route', async () => {
        const recorded: DiscoveryFetchRequest[] = [];
        const { fieldCalls, tools } = setup({}, recorded);
        const missing = await tools
            .executeTool(
                'search_field_values',
                {
                    fieldId: 'orders_status',
                    projectUuid: PROJECT_UUID,
                    search: 'pend',
                },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(missing).toBeInstanceOf(AgentToolError);
        expect((missing as AgentToolError).code).toBe('INVALID_INPUT');

        const result = (await tools.executeTool(
            'search_field_values',
            {
                fieldId: 'orders_status',
                projectUuid: PROJECT_UUID,
                search: 'pend',
                table: 'orders',
            },
            allowAllPrincipal(),
        )) as { rows: unknown[] };
        expect(result.rows).toHaveLength(1);
        expect(fieldCalls).toHaveLength(1);
        expect(fieldCalls[0]).toMatchObject({
            body: {
                fieldId: 'orders_status',
                search: 'pend',
                table: 'orders',
            },
            projectUuid: PROJECT_UUID,
        });
    });
});

describe('inspect_warehouse_columns', () => {
    it('requires schemaName and tableName and hits the fields endpoint', async () => {
        const recorded: DiscoveryFetchRequest[] = [];
        const { tools } = setup(
            {
                [`/api/v1/projects/${PROJECT_UUID}/sqlRunner/fields`]: {
                    results: { id: 'integer', status: 'text' },
                    status: 'ok',
                },
            },
            recorded,
        );
        const missing = await tools
            .executeTool(
                'inspect_warehouse_columns',
                { projectUuid: PROJECT_UUID, tableName: 'orders' },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(missing).toBeInstanceOf(AgentToolError);
        expect((missing as AgentToolError).code).toBe('INVALID_INPUT');

        const result = await tools.executeTool(
            'inspect_warehouse_columns',
            {
                projectUuid: PROJECT_UUID,
                schemaName: 'public',
                tableName: 'orders',
            },
            allowAllPrincipal(),
        );
        expect(result).toEqual({
            columns: [
                { name: 'id', type: 'integer' },
                { name: 'status', type: 'text' },
            ],
            schemaName: 'public',
            tableName: 'orders',
        });
        expect(recorded).toHaveLength(1);
        expect(recorded[0]?.query).toMatchObject({
            schemaName: 'public',
            tableName: 'orders',
        });
    });
});

describe('list_spaces_and_content', () => {
    it('lists v2 content scoped to the project', async () => {
        const recorded: DiscoveryFetchRequest[] = [];
        const { tools } = setup(
            {
                '/api/v2/content': {
                    results: {
                        data: [{ name: 'Orders dashboard', uuid: 'abc' }],
                    },
                    status: 'ok',
                },
            },
            recorded,
        );
        const result = await tools.executeTool(
            'list_spaces_and_content',
            { projectUuid: PROJECT_UUID, search: 'orders' },
            allowAllPrincipal(),
        );
        expect(result).toEqual({
            items: [{ name: 'Orders dashboard', uuid: 'abc' }],
        });
        expect(recorded[0]?.path).toBe('/api/v2/content');
        expect(recorded[0]?.query?.projectUuids).toBe(PROJECT_UUID);
    });
});

describe('get_metric_metadata', () => {
    it('reads metric metadata from the catalog endpoint', async () => {
        const recorded: DiscoveryFetchRequest[] = [];
        const { tools } = setup(
            {
                [`/api/v1/projects/${PROJECT_UUID}/dataCatalog/metrics/orders/total`]:
                    {
                        results: { type: 'sum' },
                        status: 'ok',
                    },
            },
            recorded,
        );
        const result = await tools.executeTool(
            'get_metric_metadata',
            {
                metricName: 'total',
                projectUuid: PROJECT_UUID,
                tableName: 'orders',
            },
            allowAllPrincipal(),
        );
        expect(result).toEqual({
            details: { type: 'sum' },
            metricName: 'total',
            tableName: 'orders',
        });
    });
});

describe('tool registry', () => {
    it('rejects unknown tools', async () => {
        const recorded: DiscoveryFetchRequest[] = [];
        const { tools } = setup({}, recorded);
        const error = await tools
            .executeTool(
                'run_everything',
                { projectUuid: PROJECT_UUID },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('UNKNOWN_TOOL');
    });

    it('never calls a deprecated v1 route', async () => {
        recordedAudits.length = 0;
        const recorded: DiscoveryFetchRequest[] = [];
        const responses: Record<string, unknown> = {
            [`/api/v1/projects/${PROJECT_UUID}/explores`]: { results: [] },
            [`/api/v1/projects/${PROJECT_UUID}/explores/orders`]: {
                results: { name: 'orders', tables: {} },
            },
            [`/api/v1/projects/${PROJECT_UUID}/dataCatalog/metrics/orders/total`]:
                { results: {} },
            [`/api/v1/projects/${PROJECT_UUID}/sqlRunner/fields`]: {
                results: {},
            },
            '/api/v2/content': { results: [] },
        };
        const { tools } = setup(responses, recorded);
        const principal = allowAllPrincipal();
        const visibility = { visibility: visibilityWith('orders') };
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
            'search_catalog_fields',
            { projectUuid: PROJECT_UUID, query: 'orders' },
            principal,
            visibility,
        );
        await tools.executeTool(
            'get_metric_metadata',
            {
                metricName: 'total',
                projectUuid: PROJECT_UUID,
                tableName: 'orders',
            },
            principal,
        );
        await tools.executeTool(
            'list_spaces_and_content',
            { projectUuid: PROJECT_UUID },
            principal,
        );
        await tools.executeTool(
            'inspect_warehouse_columns',
            {
                projectUuid: PROJECT_UUID,
                schemaName: 'public',
                tableName: 'orders',
            },
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
            'searchFieldValues',
        ];
        for (const request of recorded) {
            for (const marker of deprecated) {
                expect(`${request.path}${request.method}`).not.toContain(
                    marker,
                );
            }
        }
    });

    it('keeps errors white-label and secrets out of audit rows', async () => {
        recordedAudits.length = 0;
        const recorded: DiscoveryFetchRequest[] = [];
        const { tools } = setup({}, recorded);
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
            allowAllPrincipal(),
        );
        const metadata = auditMetadataOf(0);
        expect(JSON.stringify(metadata)).not.toContain('ldpat_');
        expect(JSON.stringify(metadata)).not.toContain('sample-test-token');
        const error = await tools
            .executeTool(
                'list_explores',
                { projectUuid: 'not-a-uuid' },
                allowAllPrincipal(),
            )
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentToolError);
        expect(
            String((error as AgentToolError).message).toLowerCase(),
        ).not.toContain('lightdash');
    });
});
