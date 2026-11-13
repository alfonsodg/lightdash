// Slice 1 (TDD): MCP server registers Phase 3-4 tools filtered by role.
// InMemoryTransport keeps this hermetic: no network, no database.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { AuditQueryClient } from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { defaultCapabilityToggles } from '../policy/capabilityPolicy';
import { createAgentBiMcpServer, type McpServerDeps } from './mcpServer';

const editor = (): AgentPrincipal => ({
    ability: { can: () => true },
    authType: 'session',
    cacheKey: 'mcp-editor',
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
    cacheKey: 'mcp-viewer',
    organizationUuid: 'org-1',
    userAttributesHash: 'abcd1234',
    userUuid: '22222222-2222-4222-8222-222222222222',
});

const auditClient: AuditQueryClient = {
    query: async () => undefined,
};

const neverRun = (name: string): never => {
    throw new Error(`${name} must not run during tools/list`);
};

const stubDeps = (toggles = defaultCapabilityToggles()): McpServerDeps => ({
    auditClient,
    catalogSearch: { search: () => neverRun('catalogSearch') },
    contentFetch: () => neverRun('contentFetch'),
    discoveryFetch: () => neverRun('discoveryFetch'),
    exportFetch: () => neverRun('exportFetch'),
    fieldValuesClient: {
        executeFieldValueSearch: () => neverRun('executeFieldValueSearch'),
        pollQueryToReady: () => neverRun('pollQueryToReady'),
    },
    policyContext: { toggles },
    poll: {
        initialDelayMs: 0,
        maxAttempts: 1,
        maxDelayMs: 1,
        timeoutMs: 10,
    },
    queryClient: {
        executeComposeQueries: () => neverRun('executeComposeQueries'),
        executeDashboardChart: () => neverRun('executeDashboardChart'),
        executeSavedChart: () => neverRun('executeSavedChart'),
        executeUnderlyingData: () => neverRun('executeUnderlyingData'),
        pollQueryToReady: () => neverRun('pollQueryToReady'),
        runMetricQuery: () => neverRun('runMetricQuery'),
        runSqlQuery: () => neverRun('runSqlQuery'),
    },
    rawSql: { readOnlyEnforced: true },
    renderer: { dryRun: () => neverRun('renderer') },
    sqlApproval: { readOnlyEnforced: false },
    validators: {
        chart: { validate: () => neverRun('validate') },
        dashboard: { validate: () => neverRun('validate') },
        sqlChart: { validate: () => neverRun('validate') },
    },
});

const listToolNames = async (
    principal: AgentPrincipal,
    toggles = defaultCapabilityToggles(),
): Promise<
    Array<{ description?: string; inputSchema: unknown; name: string }>
> => {
    const server = createAgentBiMcpServer({
        deps: stubDeps(toggles),
        principal,
        serverInfo: { name: 'agent-bi-test', version: '0.0.0-test' },
    });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const client = new Client(
        { name: 'agent-bi-test-client', version: '0.0.0-test' },
        { capabilities: {} },
    );
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    try {
        const result = await client.listTools();
        return result.tools.map((tool) => ({
            description: tool.description,
            inputSchema: tool.inputSchema,
            name: tool.name,
        }));
    } finally {
        await client.close();
        await server.close();
    }
};

describe('agent-bi MCP server tool filtering', () => {
    it('exposes discovery and query tools to an interactive viewer, no writes', async () => {
        const names = (await listToolNames(interactiveViewer())).map(
            (tool) => tool.name,
        );
        for (const name of [
            'list_explores',
            'search_catalog_fields',
            'run_metric_query',
            'run_compose_pipeline',
        ]) {
            expect(names).toContain(name);
        }
        for (const name of [
            'upsert_chart_as_code',
            'validate_chart_config',
            'export_dashboard_csv',
            'schedule_chart_delivery',
            'run_sql',
        ]) {
            expect(names).not.toContain(name);
        }
    });

    it('exposes read-only content and query tools to an editor', async () => {
        const names = (await listToolNames(editor())).map((tool) => tool.name);
        for (const name of [
            'list_explores',
            'get_explore',
            'search_catalog_fields',
            'run_metric_query',
            'run_saved_chart',
            'run_compose_pipeline',
            'get_chart_or_dashboard',
            'validate_chart_config',
            'export_dashboard_csv',
        ]) {
            expect(names).toContain(name);
        }
        for (const name of [
            'schedule_chart_delivery',
            'schedule_dashboard_delivery',
            'upsert_chart_as_code',
            'upsert_dashboard_as_code',
            'upsert_sql_chart_as_code',
        ]) {
            expect(names).not.toContain(name);
        }
    });

    it('hides run_sql even when the raw_sql toggle is enabled', async () => {
        const defaultNames = (await listToolNames(editor())).map(
            (tool) => tool.name,
        );
        expect(defaultNames).not.toContain('run_sql');
        const enabledNames = (
            await listToolNames(editor(), {
                ...defaultCapabilityToggles(),
                raw_sql: true,
            })
        ).map((tool) => tool.name);
        expect(enabledNames).not.toContain('run_sql');
    });

    it('rejects direct calls to actions that require confirmation', async () => {
        const server = createAgentBiMcpServer({
            deps: stubDeps({ ...defaultCapabilityToggles(), raw_sql: true }),
            principal: editor(),
        });
        const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'test', version: '1' });
        await Promise.all([
            server.connect(serverTransport),
            client.connect(clientTransport),
        ]);
        try {
            const results = await Promise.all(
                [
                    'run_sql',
                    'schedule_chart_delivery',
                    'schedule_dashboard_delivery',
                    'upsert_chart_as_code',
                    'upsert_dashboard_as_code',
                    'upsert_sql_chart_as_code',
                ].map((name) => client.callTool({ name, arguments: {} })),
            );
            for (const result of results) {
                expect(result.isError).toBe(true);
            }
        } finally {
            await client.close();
            await server.close();
        }
    });

    it('publishes a valid object JSON schema per tool', async () => {
        const tools = await listToolNames(editor());
        expect(tools.length).toBeGreaterThan(0);
        for (const tool of tools) {
            expect(
                typeof tool.inputSchema === 'object' &&
                    tool.inputSchema !== null &&
                    (tool.inputSchema as { type?: unknown }).type,
            ).toBe('object');
        }
    });

    it('keeps tool descriptions white-label', async () => {
        const tools = await listToolNames(editor());
        const descriptions = tools.map((tool) => tool.description ?? '');
        expect(descriptions.join(' ')).not.toMatch(/lightdash/i);
    });
});
