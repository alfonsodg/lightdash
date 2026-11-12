// Shared tool catalogue (TDD red): single source for MCP registration and
// the runtime orchestrator. No network, no database.
import { describe, expect, it } from 'vitest';
import {
    createToolCatalog,
    TOOL_CATALOG,
    type ToolCatalogAllDeps,
} from './toolCatalog';
import { defaultCapabilityToggles } from '../policy/capabilityPolicy';
import type { AgentPrincipal } from '../auth/agentPrincipal';

const principal = (): AgentPrincipal => ({
    ability: { can: () => true },
    authType: 'session',
    cacheKey: 'catalog-test',
    organizationUuid: 'org-1',
    userAttributesHash: 'abcd1234',
    userUuid: '11111111-1111-4111-8111-111111111111',
});

const stubDeps = (): ToolCatalogAllDeps => ({
    auditClient: { query: async () => undefined },
    catalogSearch: {
        search: async () => {
            throw new Error('not used');
        },
    },
    contentFetch: async () => {
        throw new Error('not used');
    },
    discoveryFetch: async () => [{ label: 'Orders', name: 'orders' }],
    exportFetch: async () => {
        throw new Error('not used');
    },
    fieldValuesClient: {
        executeFieldValueSearch: async () => {
            throw new Error('not used');
        },
        pollQueryToReady: async () => {
            throw new Error('not used');
        },
    },
    policyContext: { toggles: defaultCapabilityToggles() },
    poll: { initialDelayMs: 0, maxAttempts: 1, maxDelayMs: 1, timeoutMs: 10 },
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
        pollQueryToReady: async () => {
            throw new Error('not used');
        },
        runMetricQuery: async () => {
            throw new Error('not used');
        },
        runSqlQuery: async () => {
            throw new Error('not used');
        },
    },
    rawSql: { readOnlyEnforced: true },
    renderer: {
        dryRun: async () => {
            throw new Error('not used');
        },
    },
    sqlApproval: { readOnlyEnforced: false },
    validators: {
        chart: {
            validate: async () => {
                throw new Error('not used');
            },
        },
        dashboard: {
            validate: async () => {
                throw new Error('not used');
            },
        },
        sqlChart: {
            validate: async () => {
                throw new Error('not used');
            },
        },
    },
});

describe('tool catalogue', () => {
    it('registers every Phase 3-4 tool once with white-label copy', () => {
        expect(TOOL_CATALOG).toHaveLength(22);
        const names = TOOL_CATALOG.map((entry) => entry.name);
        expect(new Set(names).size).toBe(names.length);
        for (const entry of TOOL_CATALOG) {
            expect(entry.description.length).toBeGreaterThan(0);
            expect(entry.description).not.toMatch(/lightdash/i);
            expect(typeof entry.inputSchema.parse).toBe('function');
        }
    });

    it('rejects unknown tools with a code', async () => {
        const catalog = createToolCatalog(stubDeps());
        await expect(
            catalog.execute('delete_everything', {}, principal()),
        ).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
    });

    it('executes discovery tools through the owning module', async () => {
        const catalog = createToolCatalog(stubDeps());
        const result = (await catalog.execute(
            'list_explores',
            { projectUuid: '22222222-2222-4222-8222-222222222222' },
            principal(),
        )) as { explores: Array<{ name: string }> };
        expect(result.explores.map((explore) => explore.name)).toEqual([
            'orders',
        ]);
    });
});
