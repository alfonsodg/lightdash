// Slice 3-4: MCP Streamable HTTP transport on /api/ext/v1/mcp.
// Live loopback through real HTTP; fake tool deps (no database, real SDK).
import { Ability } from '@casl/ability';
import {
    defaultCapabilityToggles,
    type McpServerDeps,
    type V2ReadyPage,
} from '@lightdash/agent-bi';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import express, { type ErrorRequestHandler } from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { defaultSessionUser } from '../auth/account/account.mock';
import { createMcpExtRouter } from './mcpExtRouter';

vi.mock('../controllers/authentication', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('../controllers/authentication')>();
    return {
        ...actual,
        allowApiKeyAuthentication: (
            _req: unknown,
            _res: unknown,
            next: () => void,
        ) => next(),
    };
});

// This suite drives a live loopback server through real HTTP, so opt out
// of the global fetch stub installed by setupVitest.ts for unit tests.
vi.unstubAllGlobals();

const PROJECT_UUID = '22222222-2222-4222-8222-222222222222';

const startApp = async (options?: {
    createMcpDeps?: () => McpServerDeps;
    godMode?: boolean;
}) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (options?.godMode === true) {
            // Real users carry uuids; the shared mock uses a placeholder
            // that the audit insert would reject.
            const user = {
                ...defaultSessionUser,
                userUuid: '11111111-1111-4111-8111-111111111111',
            };
            user.ability = new Ability([{ action: 'manage', subject: 'all' }]);
            req.user = user;
        }
        req.services = {
            getFeatureFlagService: () => ({
                get: async () => ({ enabled: true }),
            }),
            getOauthService: () => ({
                getSiteUrl: () => 'https://instance.example',
            }),
        } as never;
        next();
    });
    app.use(
        '/api/ext/v1/mcp',
        createMcpExtRouter({
            createMcpDeps:
                options?.createMcpDeps ??
                (() => {
                    throw new Error('deps must not run unauthenticated');
                }),
        }),
    );
    const errors: ErrorRequestHandler = (error, _req, res, _next) => {
        res.status(error.statusCode ?? 500).json({
            error: error.name,
            message: error.message,
        });
    };
    app.use(errors);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
};

const stopApp = async (
    server: Awaited<ReturnType<typeof startApp>>,
): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
};

const connectClient = async (
    base: string,
): Promise<{ client: Client; close: () => Promise<void> }> => {
    const client = new Client(
        { name: 'mcp-contract-client', version: '1' },
        { capabilities: {} },
    );
    await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/api/ext/v1/mcp`)),
    );
    return {
        client,
        close: async () => {
            await client.close();
        },
    };
};

describe('mcpExtRouter auth contract', () => {
    it('rejects unauthenticated POST with 401 plus OAuth discovery metadata', async () => {
        const server = await startApp();
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const response = await fetch(`${base}/api/ext/v1/mcp`, {
                headers: { 'content-type': 'application/json' },
                method: 'POST',
            });
            expect(response.status).toBe(401);
            expect(response.headers.get('www-authenticate') ?? '').toContain(
                'oauth-protected-resource',
            );
        } finally {
            await stopApp(server);
        }
    });
});

describe('mcpExtRouter authenticated tools', () => {
    const setupDeps = () => {
        const recordedAudits: Array<{ params: unknown[]; text: string }> = [];
        const recordedPaths: string[] = [];
        const readyPage = (): V2ReadyPage => ({
            columns: {},
            nextPage: null,
            page: 1,
            pageSize: 10,
            previousPage: null,
            queryUuid: 'query-1',
            rows: [],
            status: 'ready',
            totalPageCount: 1,
            totalResults: 0,
        });
        const createMcpDeps = (): McpServerDeps => ({
            auditClient: {
                query: async (text: string, params?: unknown[]) => {
                    recordedAudits.push({ params: params ?? [], text });
                    return undefined;
                },
            },
            catalogSearch: {
                search: async () => [],
            },
            contentFetch: async (request) => {
                recordedPaths.push(request.path);
                return { results: { uuid: 'chart-1' }, status: 'ok' };
            },
            discoveryFetch: async (request) => {
                recordedPaths.push(request.path);
                return [{ label: 'Orders', name: 'orders' }];
            },
            exportFetch: async (request) => {
                recordedPaths.push(request.path);
                return { results: null, status: 'ok' };
            },
            fieldValuesClient: {
                executeFieldValueSearch: async () => ({
                    queryUuid: 'query-1',
                }),
                pollQueryToReady: async () => readyPage(),
            },
            policyContext: { toggles: defaultCapabilityToggles() },
            poll: {
                initialDelayMs: 0,
                maxAttempts: 1,
                maxDelayMs: 1,
                timeoutMs: 1000,
            },
            queryClient: {
                executeComposeQueries: async () => {
                    throw new Error('not used');
                },
                executeDashboardChart: async () => {
                    throw new Error('not used');
                },
                executeSavedChart: async () => {
                    throw new Error('not used');
                },
                executeUnderlyingData: async () => {
                    throw new Error('not used');
                },
                pollQueryToReady: async () => readyPage(),
                runMetricQuery: async () => readyPage(),
                runSqlQuery: async () => {
                    throw new Error('not used');
                },
            },
            rawSql: { readOnlyEnforced: true },
            renderer: {
                dryRun: async () => ({ complete: true }),
            },
            sqlApproval: { readOnlyEnforced: false },
            validators: {
                chart: {
                    validate: async () => ({ errors: [], valid: true }),
                },
                dashboard: {
                    validate: async () => ({ errors: [], valid: true }),
                },
                sqlChart: {
                    validate: async () => ({ errors: [], valid: true }),
                },
            },
        });
        return { createMcpDeps, recordedAudits, recordedPaths };
    };

    const auditToolOf = (
        recordedAudits: Array<{ params: unknown[]; text: string }>,
        tool: string,
    ): boolean =>
        recordedAudits.some(
            (row) =>
                row.text.includes('"agent_ext"."audit_logs"') &&
                (row.params as unknown[]).some(
                    (param) =>
                        typeof param === 'string' && param.includes(tool),
                ),
        );

    it('lists the governed catalogue without raw_sql by default', async () => {
        const { createMcpDeps } = setupDeps();
        const server = await startApp({ createMcpDeps, godMode: true });
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const { client, close } = await connectClient(base);
            try {
                const listed = await client.listTools();
                const names = listed.tools.map((tool) => tool.name);
                expect(names).toHaveLength(21);
                for (const name of [
                    'list_explores',
                    'run_metric_query',
                    'upsert_chart_as_code',
                    'export_dashboard_csv',
                ]) {
                    expect(names).toContain(name);
                }
                expect(names).not.toContain('run_sql');
            } finally {
                await close();
            }
        } finally {
            await stopApp(server);
        }
    });

    it('executes list_explores and writes an audit row', async () => {
        const { createMcpDeps, recordedAudits } = setupDeps();
        const server = await startApp({ createMcpDeps, godMode: true });
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const { client, close } = await connectClient(base);
            try {
                const called = await client.callTool({
                    arguments: { projectUuid: PROJECT_UUID },
                    name: 'list_explores',
                });
                expect(called.content).toBeDefined();
                expect(auditToolOf(recordedAudits, 'list_explores')).toBe(true);
            } finally {
                await close();
            }
        } finally {
            await stopApp(server);
        }
    });

    it('executes run_metric_query and writes an audit row', async () => {
        const { createMcpDeps, recordedAudits } = setupDeps();
        const server = await startApp({ createMcpDeps, godMode: true });
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const { client, close } = await connectClient(base);
            try {
                const called = await client.callTool({
                    arguments: {
                        dimensions: ['orders_status'],
                        exploreName: 'orders',
                        metrics: ['orders_total'],
                        projectUuid: PROJECT_UUID,
                    },
                    name: 'run_metric_query',
                });
                expect(called.content).toBeDefined();
                expect(auditToolOf(recordedAudits, 'run_metric_query')).toBe(
                    true,
                );
            } finally {
                await close();
            }
        } finally {
            await stopApp(server);
        }
    });

    it('executes upsert_chart_as_code and writes an audit row', async () => {
        const { createMcpDeps, recordedAudits } = setupDeps();
        const server = await startApp({ createMcpDeps, godMode: true });
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const { client, close } = await connectClient(base);
            try {
                const called = await client.callTool({
                    arguments: {
                        chart: {
                            name: 'Revenue',
                            spaceSlug: 'marketing',
                        },
                        projectUuid: PROJECT_UUID,
                        slug: 'test-chart',
                    },
                    name: 'upsert_chart_as_code',
                });
                expect(called.content).toBeDefined();
                expect(
                    auditToolOf(recordedAudits, 'upsert_chart_as_code'),
                ).toBe(true);
            } finally {
                await close();
            }
        } finally {
            await stopApp(server);
        }
    });
});
