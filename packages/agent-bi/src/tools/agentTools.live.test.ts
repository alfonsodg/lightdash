// Live shape test (Slice D): catalog sync plus one metric query end to end.
//
// Runs ONLY when AGENT_BI_TEST_DATABASE_URL is set (Sandbox/CI); the suite
// skips otherwise so workstation runs never need a database. Full Jaffle
// Shop plus MinIO verification stays out of scope on this host.

import { createServer, type Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { recordAuditEvent } from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import {
    searchCatalogDocuments,
    syncCatalogIndex,
    type CatalogDocument,
    type CatalogExistingRow,
    type CatalogExploreInput,
    type CatalogIndexKey,
    type CatalogIndexStore,
} from '../catalog/catalogIndexer';
import {
    createLightdashV2Client,
    type V2QueryResult,
} from '../client/lightdashV2Client';
import { defaultCapabilityToggles } from '../policy/capabilityPolicy';
import { createAgentTools } from './index';

const DATABASE_URL = process.env['AGENT_BI_TEST_DATABASE_URL'] ?? '';
const hasDatabase = DATABASE_URL.length > 0;

const PROJECT_UUID = '22222222-2222-4222-8222-222222222222';
const METRIC_QUERY_UUID = '33333333-3333-4333-8333-333333333333';

type PgClient = {
    query(
        text: string,
        params?: unknown[],
    ): Promise<{ rows: Array<Record<string, unknown>> }>;
    end(): Promise<void>;
};

let pg: PgClient | undefined;

const db = async (): Promise<PgClient> => {
    if (pg) {
        return pg;
    }
    const { Client } = await import('pg');
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    pg = client as PgClient;
    return pg;
};

afterAll(async () => {
    await pg?.end();
    pg = undefined;
});

const seededExplore = (): CatalogExploreInput => ({
    baseTable: 'orders',
    description: 'Seeded shop orders',
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
});

const pgStore = (client: PgClient): CatalogIndexStore => ({
    deleteKeys: async (keys: CatalogIndexKey[]) => {
        await Promise.all(
            keys.map((key) =>
                client.query(
                    `DELETE FROM agent_ext.catalog_index WHERE project_uuid = $1 AND resource_type = $2 AND resource_uuid = $3`,
                    [PROJECT_UUID, key.resourceType, key.resourceUuid],
                ),
            ),
        );
    },
    listExisting: async () => {
        const result = await client.query(
            `SELECT resource_type, resource_uuid, content FROM agent_ext.catalog_index WHERE project_uuid = $1`,
            [PROJECT_UUID],
        );
        return result.rows.map(
            (row): CatalogExistingRow => ({
                content: String(row['content'] ?? ''),
                resourceType: String(row['resource_type']),
                resourceUuid: String(row['resource_uuid']),
            }),
        );
    },
    upsertRows: async (rows: CatalogDocument[]) => {
        await Promise.all(
            rows.map((row) =>
                client.query(
                    `INSERT INTO agent_ext.catalog_index (project_uuid, resource_type, resource_uuid, content, document)
                     VALUES ($1, $2, $3, $4, to_tsvector('english', $4))
                     ON CONFLICT (project_uuid, resource_type, resource_uuid)
                     DO UPDATE SET content = EXCLUDED.content, document = EXCLUDED.document, updated_at = now()`,
                    [
                        PROJECT_UUID,
                        row.resourceType,
                        row.resourceUuid,
                        row.content,
                    ],
                ),
            ),
        );
    },
});

const principal = (): AgentPrincipal => ({
    ability: {
        can: (action: string, subject: string) =>
            action === 'view' &&
            (subject === 'Project' || subject === 'Explore'),
    },
    authType: 'session',
    cacheKey: 'live-principal',
    organizationUuid: 'org-1',
    userAttributesHash: 'abcd1234',
    userUuid: '11111111-1111-4111-8111-111111111111',
});

describe.skipIf(!hasDatabase)('agent tools live shape', () => {
    it('indexes the seeded project and finds it through the catalog', async () => {
        const client = await db();
        const { migrateUp } = await import('../db/migrate');
        await migrateUp({ query: (text: string) => client.query(text) });
        await client.query(
            `DELETE FROM agent_ext.catalog_index WHERE project_uuid = $1`,
            [PROJECT_UUID],
        );

        const synced = await syncCatalogIndex(pgStore(client), PROJECT_UUID, [
            seededExplore(),
        ]);
        expect(synced.upserted).toBeGreaterThan(0);

        const stored = await pgStore(client).listExisting(PROJECT_UUID);
        expect(stored.length).toBe(synced.upserted + synced.unchanged);

        const hits = searchCatalogDocuments(
            stored.map(
                (row, index): CatalogDocument => ({
                    content: row.content,
                    contentHash: `live-${index}`,
                    embedding: null,
                    exploreName: 'orders',
                    fieldKind: null,
                    fieldName: null,
                    projectUuid: PROJECT_UUID,
                    resourceType: 'explore',
                    resourceUuid: row.resourceUuid,
                    tableName: null,
                }),
            ),
            'orders',
            { allowedExplores: new Set(['orders']) },
        );
        expect(hits.length).toBeGreaterThan(0);
    });

    it('runs one metric query end to end through the tool executor', async () => {
        const seen: string[] = [];
        const server: Server = createServer((req, res) => {
            seen.push(`${req.method} ${req.url}`);
            if (
                req.method === 'POST' &&
                req.url?.endsWith('/query/metric-query')
            ) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        results: {
                            cacheMetadata: {},
                            parameterReferences: [],
                            queryUuid: METRIC_QUERY_UUID,
                            resolvedTimezone: null,
                            usedParametersValues: {},
                        },
                        status: 'ok',
                    }),
                );
                return;
            }
            const ready: V2QueryResult = {
                columns: { orders_total: { type: 'number' } },
                nextPage: null,
                page: 1,
                pageSize: 10,
                previousPage: null,
                queryUuid: METRIC_QUERY_UUID,
                rows: [{ orders_total: 42 }],
                status: 'ready',
                totalPageCount: 1,
                totalResults: 1,
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ results: ready, status: 'ok' }));
        });
        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => {
                resolve();
            });
        });
        try {
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new Error('Loopback server did not bind a port');
            }
            const client = createLightdashV2Client({
                baseUrl: `http://127.0.0.1:${String(address.port)}`,
                pollInitialDelayMs: 1,
                pollMaxAttempts: 3,
                pollMaxDelayMs: 2,
            });
            const auditClient = {
                query: (text: string, params?: unknown[]) =>
                    db().then((pgClient) =>
                        pgClient.query(text, params).then(() => undefined),
                    ),
            };
            const tools = createAgentTools({
                auditClient,
                catalogSearch: { search: () => [] },
                discoveryFetch: async () => ({ results: [], status: 'ok' }),
                fieldValuesClient: client,
                policyContext: { toggles: defaultCapabilityToggles() },
                queryClient: client,
                rawSql: { readOnlyEnforced: true },
            });
            const result = (await tools.executeTool(
                'run_metric_query',
                {
                    exploreName: 'orders',
                    metrics: ['orders_total'],
                    projectUuid: PROJECT_UUID,
                },
                principal(),
            )) as { rows: Array<{ orders_total: number }> };
            expect(result.rows).toEqual([{ orders_total: 42 }]);
            expect(
                seen.some((line) => line.includes('/query/metric-query')),
            ).toBe(true);
            const audit = await (
                await db()
            ).query(`SELECT COUNT(*) AS n FROM agent_ext.audit_logs`);
            expect(Number(audit.rows[0]?.['n'])).toBeGreaterThan(0);
        } finally {
            await new Promise<void>((resolve) => {
                server.close(() => {
                    resolve();
                });
            });
        }
    });

    it('writes audit rows through the shared logger', async () => {
        const client = await db();
        await recordAuditEvent(
            { query: (text: string) => client.query(text) },
            {
                capability: 'metric_query',
                principal: {
                    organizationUuid: 'org-1',
                    userUuid: '11111111-1111-4111-8111-111111111111',
                },
                projectUuid: PROJECT_UUID,
                tool: 'run_metric_query',
                verdict: 'allow',
            },
        );
        const audit = await client.query(
            `SELECT COUNT(*) AS n FROM agent_ext.audit_logs`,
        );
        expect(Number(audit.rows[0]?.['n'])).toBeGreaterThan(0);
    });
});
