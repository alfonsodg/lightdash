// Export live skeleton (Phase 4): migrated schema plus one async dashboard
// CSV export end to end.
//
// Runs ONLY when AGENT_BI_TEST_DATABASE_URL is set (Sandbox/CI); the suite
// skips otherwise so workstation runs never need a database. A loopback
// HTTP server stands in for the backend export routes, so no workstation
// backend is required either.

import { createServer, type Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { recordAuditEvent } from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { defaultCapabilityToggles } from '../policy/capabilityPolicy';
import { createExportFetchClient } from './exportFetch';
import { createExportTools } from './exportTools';

const DATABASE_URL = process.env['AGENT_BI_TEST_DATABASE_URL'] ?? '';
const hasDatabase = DATABASE_URL.length > 0;

const PROJECT_UUID = '22222222-2222-4222-8222-222222222222';
const DASHBOARD_UUID = '44444444-4444-4434-8444-444444444444';
const JOB_ID = 'live-job-1';
const FILE_URL = 'https://files.example/live.csv';

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

const exporter = (): AgentPrincipal => ({
    ability: {
        can: (action: string, subject: string) =>
            action === 'create' && subject === 'ScheduledDeliveries',
    },
    authType: 'session',
    cacheKey: 'live-exporter',
    organizationUuid: 'org-1',
    userAttributesHash: 'abcd1234',
    userUuid: '11111111-1111-4111-8111-111111111111',
});

const migrate = async (client: PgClient): Promise<void> => {
    const { migrateUp } = await import('../db/migrate');
    await migrateUp({
        query: (text: string) => client.query(text, []).then(() => undefined),
    });
};

describe.skipIf(!hasDatabase)('export tools live skeleton', () => {
    it('migrates the agent_ext schema and writes an audit row', async () => {
        const client = await db();
        await migrate(client);
        await recordAuditEvent(
            {
                query: (text: string, params?: unknown[]) =>
                    client.query(text, params).then(() => undefined),
            },
            {
                capability: 'export',
                principal: {
                    organizationUuid: 'org-1',
                    userUuid: '11111111-1111-4111-8111-111111111111',
                },
                projectUuid: PROJECT_UUID,
                tool: 'export_dashboard_csv',
                verdict: 'allow',
            },
        );
        const audit = await client.query(
            `SELECT COUNT(*) AS n FROM agent_ext.audit_logs`,
            [],
        );
        expect(Number(audit.rows[0]?.['n'])).toBeGreaterThan(0);
    });

    it('polls one dashboard CSV export through the async API surface', async () => {
        const client = await db();
        await migrate(client);
        const seen: string[] = [];
        let polls = 0;
        const server: Server = createServer((req, res) => {
            seen.push(`${req.method} ${req.url}`);
            if (
                req.method === 'POST' &&
                req.url === `/api/v2/dashboards/${DASHBOARD_UUID}/exports`
            ) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        results: { jobId: JOB_ID },
                        status: 'ok',
                    }),
                );
                return;
            }
            if (
                req.method === 'GET' &&
                req.url === `/api/v1/schedulers/job/${JOB_ID}/status`
            ) {
                polls += 1;
                const ready = polls > 1;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        results: ready
                            ? {
                                  details: { url: FILE_URL },
                                  status: 'completed',
                              }
                            : { details: null, status: 'scheduled' },
                        status: 'ok',
                    }),
                );
                return;
            }
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'error' }));
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
            const tools = createExportTools({
                auditClient: {
                    query: (text: string, params?: unknown[]) =>
                        client.query(text, params).then(() => undefined),
                },
                exportFetch: createExportFetchClient({
                    baseUrl: `http://127.0.0.1:${String(address.port)}`,
                }),
                policyContext: { toggles: defaultCapabilityToggles() },
                poll: {
                    initialDelayMs: 1,
                    maxAttempts: 10,
                    maxDelayMs: 5,
                    sleep: () => Promise.resolve(),
                    timeoutMs: 10_000,
                },
            });
            const result = await tools.executeTool(
                'export_dashboard_csv',
                { dashboardUuid: DASHBOARD_UUID, projectUuid: PROJECT_UUID },
                exporter(),
            );
            expect(result).toEqual({
                dashboardUuid: DASHBOARD_UUID,
                fileUrl: FILE_URL,
                format: 'csv',
                jobId: JOB_ID,
            });
            expect(
                seen.some((line) =>
                    line.includes(
                        `/api/v2/dashboards/${DASHBOARD_UUID}/exports`,
                    ),
                ),
            ).toBe(true);
            expect(
                seen.some((line) =>
                    line.includes(`/api/v1/schedulers/job/${JOB_ID}/status`),
                ),
            ).toBe(true);
            const audit = await client.query(
                `SELECT COUNT(*) AS n FROM agent_ext.audit_logs`,
                [],
            );
            expect(Number(audit.rows[0]?.['n'])).toBeGreaterThan(0);
        } finally {
            await new Promise<void>((resolve) => {
                server.close(() => {
                    resolve();
                });
            });
        }
    });
});
