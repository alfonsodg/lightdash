// Content-as-code tools (Slice E): slug upsert, read-back and validation
// over the canonical `/code/*` routes only. Fakes only at the HTTP,
// validator and renderer seams; no live server, no database.

import { describe, expect, it } from 'vitest';
import type { AuditQueryClient } from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { defaultCapabilityToggles } from '../policy/capabilityPolicy';
import { AgentToolError } from '../tools/agentToolTypes';
import {
    buildCodeChartItemPath,
    buildCodeChartsPath,
    buildCodeDashboardItemPath,
    buildCodeDashboardsPath,
    buildCodeSqlChartItemPath,
    buildCodeSqlChartsPath,
    type ContentFetch,
} from './contentFetch';
import {
    CONTENT_TOOL_NAMES,
    createContentTools,
    type ChartDryRunResult,
    type ContentSchemaValidator,
    type ContentToolDeps,
    type ContentValidators,
} from './contentTools';

const PROJECT_UUID = '22222222-2222-4222-8222-222222222222';
const USER_UUID = '11111111-1111-4111-8111-111111111111';
const ORG_UUID = 'org-1';
const SLUG = 'revenue-by-month';

const contentWriter = (): AgentPrincipal => ({
    ability: {
        can: (action: string, subject: string) =>
            action === 'create' && subject === 'ContentAsCode',
    },
    authType: 'session',
    cacheKey: 'content-writer',
    organizationUuid: ORG_UUID,
    userAttributesHash: 'abcd1234',
    userUuid: USER_UUID,
});

const viewer = (): AgentPrincipal => ({
    ability: { can: () => false },
    authType: 'session',
    cacheKey: 'content-viewer',
    organizationUuid: ORG_UUID,
    userAttributesHash: 'abcd1234',
    userUuid: USER_UUID,
});

const allowAllValidators = (): ContentValidators => {
    const allow: ContentSchemaValidator = {
        validate: () => ({ errors: [], valid: true }),
    };
    return { chart: allow, dashboard: allow, sqlChart: allow };
};

const setup = (options?: {
    fetch?: ContentFetch;
    validators?: ContentValidators;
    renderer?: (kind: string, content: unknown) => ChartDryRunResult;
    toggles?: { content_write: boolean };
    sqlApproval?: Partial<ContentToolDeps['sqlApproval']>;
}) => {
    const recordedRequests: Array<{
        body?: unknown;
        method: string;
        path: string;
        query?: Record<string, string | undefined>;
    }> = [];
    const recordedAudits: Array<{ text: string; params: unknown[] }> = [];
    const auditClient: AuditQueryClient = {
        query: async (text: string, params?: unknown[]) => {
            recordedAudits.push({ params: params ?? [], text });
            return undefined;
        },
    };
    const fetchImpl: ContentFetch =
        options?.fetch ??
        (async (request) => {
            recordedRequests.push(request);
            return { results: {}, status: 'ok' };
        });
    const contentFetch: ContentFetch = (request, fetchOptions) =>
        fetchImpl(request, fetchOptions);
    const deps: ContentToolDeps = {
        auditClient,
        contentFetch,
        policyContext: {
            toggles: {
                ...defaultCapabilityToggles(),
                ...(options?.toggles !== undefined
                    ? { content_write: options.toggles.content_write }
                    : {}),
            },
        },
        renderer: {
            dryRun: (kind, content) =>
                options?.renderer?.(kind, content) ?? { complete: true },
        },
        sqlApproval: {
            expectedApprovalToken: 'approve-1',
            readOnlyEnforced: true,
            ...(options?.sqlApproval ?? {}),
        },
        validators: options?.validators ?? allowAllValidators(),
    };
    return {
        deps,
        recordedAudits,
        recordedRequests,
        tools: createContentTools(deps),
    };
};

const verdictOf = (params: unknown[]): string => {
    const metadata = JSON.parse(String(params[4])) as { verdict: string };
    return metadata.verdict;
};

const capabilityOf = (params: unknown[]): string => {
    const metadata = JSON.parse(String(params[4])) as { capability: string };
    return metadata.capability;
};

const toolOf = (params: unknown[]): string => {
    const metadata = JSON.parse(String(params[4])) as { tool: string };
    return metadata.tool;
};

describe('content tool names', () => {
    it('exposes the five Phase-4 content tools', () => {
        expect([...CONTENT_TOOL_NAMES]).toEqual([
            'upsert_chart_as_code',
            'upsert_sql_chart_as_code',
            'upsert_dashboard_as_code',
            'get_chart_or_dashboard',
            'validate_chart_config',
        ]);
    });
});

describe('unknown tool and invalid input', () => {
    it('rejects unknown tools without auditing', async () => {
        const { recordedAudits, tools } = setup();
        await expect(
            tools.executeTool(
                'delete_everything',
                { projectUuid: PROJECT_UUID },
                contentWriter(),
            ),
        ).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
        expect(recordedAudits).toHaveLength(0);
    });

    it('rejects invalid input without auditing', async () => {
        const { recordedAudits, tools } = setup();
        await expect(
            tools.executeTool(
                'upsert_chart_as_code',
                { projectUuid: 'not-a-uuid', slug: SLUG, chart: {} },
                contentWriter(),
            ),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(recordedAudits).toHaveLength(0);
    });
});

describe('capability gate and audit', () => {
    it('denies viewers and writes exactly one deny row', async () => {
        const { recordedAudits, tools } = setup();
        const error = await tools
            .executeTool(
                'upsert_chart_as_code',
                {
                    chart: { name: 'Revenue', spaceSlug: 'marketing' },
                    projectUuid: PROJECT_UUID,
                    slug: SLUG,
                },
                viewer(),
            )
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('POLICY_DENIED');
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
        expect(capabilityOf(recordedAudits[0].params)).toBe('content_write');
        expect(toolOf(recordedAudits[0].params)).toBe('upsert_chart_as_code');
    });

    it('denies when the content_write toggle is off', async () => {
        const { recordedAudits, tools } = setup({
            toggles: { content_write: false },
        });
        const error = await tools
            .executeTool(
                'get_chart_or_dashboard',
                { kind: 'chart', projectUuid: PROJECT_UUID, slug: SLUG },
                contentWriter(),
            )
            .catch((caught: unknown) => caught);
        expect((error as AgentToolError).code).toBe('POLICY_DENIED');
        expect((error as AgentToolError).reason).toBe('CAPABILITY_DISABLED');
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
    });

    it('keeps policy messages white-label', async () => {
        const { tools } = setup();
        const error = await tools
            .executeTool(
                'upsert_dashboard_as_code',
                {
                    dashboard: { name: 'Board', spaceSlug: 'marketing' },
                    projectUuid: PROJECT_UUID,
                    slug: SLUG,
                },
                viewer(),
            )
            .catch((caught: unknown) => caught);
        expect((error as AgentToolError).message).not.toMatch(/lightdash/i);
    });
});

describe('upsert_chart_as_code', () => {
    it('posts to the canonical chart code route and audits allow', async () => {
        const { recordedAudits, recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                return {
                    results: { charts: [{ action: 'create' }] },
                    status: 'ok',
                };
            },
        });
        const result = await tools.executeTool(
            'upsert_chart_as_code',
            {
                chart: { name: 'Revenue', spaceSlug: 'marketing' },
                projectUuid: PROJECT_UUID,
                slug: SLUG,
            },
            contentWriter(),
        );
        expect(result).toMatchObject({ slug: SLUG });
        expect(recordedRequests).toHaveLength(1);
        expect(recordedRequests[0].method).toBe('POST');
        expect(recordedRequests[0].path).toBe(
            buildCodeChartItemPath(PROJECT_UUID, SLUG),
        );
        expect(recordedRequests[0].path).not.toMatch(/\/saved/);
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('allow');
    });

    it('rejects schema-invalid charts before any HTTP call', async () => {
        const deny: ContentSchemaValidator = {
            validate: () => ({
                errors: ['/name: must be a non-empty string'],
                valid: false,
            }),
        };
        const { recordedAudits, recordedRequests, tools } = setup({
            validators: { ...allowAllValidators(), chart: deny },
        });
        const error = await tools
            .executeTool(
                'upsert_chart_as_code',
                {
                    chart: { spaceSlug: 'marketing' },
                    projectUuid: PROJECT_UUID,
                    slug: SLUG,
                },
                contentWriter(),
            )
            .catch((caught: unknown) => caught);
        expect((error as AgentToolError).code).toBe('INVALID_INPUT');
        expect(recordedRequests).toHaveLength(0);
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
    });
});

describe('upsert_sql_chart_as_code', () => {
    const sqlChart = {
        chartKind: 'cartesian',
        config: { type: 'cartesian' },
        limit: 100,
        name: 'SQL revenue',
        spaceSlug: 'marketing',
        sql: 'SELECT status FROM orders',
    };

    it('requires a human approval token', async () => {
        const { recordedAudits, recordedRequests, tools } = setup();
        const error = await tools
            .executeTool(
                'upsert_sql_chart_as_code',
                {
                    projectUuid: PROJECT_UUID,
                    slug: SLUG,
                    sqlChart,
                },
                contentWriter(),
            )
            .catch((caught: unknown) => caught);
        expect((error as AgentToolError).code).toBe('GUARD_DENIED');
        expect((error as AgentToolError).reason).toBe('MISSING_APPROVAL');
        expect(recordedRequests).toHaveLength(0);
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
    });

    it('rejects a mismatched approval token', async () => {
        const { tools } = setup();
        const error = await tools
            .executeTool(
                'upsert_sql_chart_as_code',
                {
                    approvalToken: 'wrong-token',
                    projectUuid: PROJECT_UUID,
                    slug: SLUG,
                    sqlChart,
                },
                contentWriter(),
            )
            .catch((caught: unknown) => caught);
        expect((error as AgentToolError).code).toBe('GUARD_DENIED');
        expect((error as AgentToolError).reason).toBe('APPROVAL_MISMATCH');
    });

    it('denies write SQL even with a bound approval token', async () => {
        const { recordedRequests, tools } = setup();
        const error = await tools
            .executeTool(
                'upsert_sql_chart_as_code',
                {
                    approvalToken: 'approve-1',
                    projectUuid: PROJECT_UUID,
                    slug: SLUG,
                    sqlChart: { ...sqlChart, sql: 'DROP TABLE orders' },
                },
                contentWriter(),
            )
            .catch((caught: unknown) => caught);
        expect((error as AgentToolError).code).toBe('GUARD_DENIED');
        expect(recordedRequests).toHaveLength(0);
    });

    it('upserts read-only SQL with a bound token via the code route', async () => {
        const { recordedAudits, recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                return {
                    results: { sqlCharts: [{ action: 'create' }] },
                    status: 'ok',
                };
            },
        });
        const result = await tools.executeTool(
            'upsert_sql_chart_as_code',
            {
                approvalToken: 'approve-1',
                projectUuid: PROJECT_UUID,
                slug: SLUG,
                sqlChart,
            },
            contentWriter(),
        );
        expect(result).toMatchObject({ slug: SLUG });
        expect(recordedRequests).toHaveLength(1);
        expect(recordedRequests[0].method).toBe('POST');
        expect(recordedRequests[0].path).toBe(
            buildCodeSqlChartItemPath(PROJECT_UUID, SLUG),
        );
        const body = recordedRequests[0].body as Record<string, unknown>;
        expect(body).not.toHaveProperty('approvalToken');
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('allow');
    });

    it('denies when the warehouse is not read-only attested', async () => {
        const { tools } = setup({ sqlApproval: { readOnlyEnforced: false } });
        const error = await tools
            .executeTool(
                'upsert_sql_chart_as_code',
                {
                    approvalToken: 'approve-1',
                    projectUuid: PROJECT_UUID,
                    slug: SLUG,
                    sqlChart,
                },
                contentWriter(),
            )
            .catch((caught: unknown) => caught);
        expect((error as AgentToolError).code).toBe('GUARD_DENIED');
        expect((error as AgentToolError).reason).toBe('READ_ONLY_UNVERIFIED');
    });
});

describe('upsert_dashboard_as_code', () => {
    it('posts to the canonical dashboard code route', async () => {
        const { recordedAudits, recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                return {
                    results: { dashboards: [{ action: 'update' }] },
                    status: 'ok',
                };
            },
        });
        const result = await tools.executeTool(
            'upsert_dashboard_as_code',
            {
                dashboard: { name: 'Board', spaceSlug: 'marketing', tiles: [] },
                projectUuid: PROJECT_UUID,
                slug: SLUG,
            },
            contentWriter(),
        );
        expect(result).toMatchObject({ slug: SLUG });
        expect(recordedRequests[0].path).toBe(
            buildCodeDashboardItemPath(PROJECT_UUID, SLUG),
        );
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('allow');
    });
});

describe('get_chart_or_dashboard', () => {
    it('reads charts through the code list route', async () => {
        const item = { name: 'Revenue', slug: SLUG };
        const { recordedAudits, recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                return { results: { charts: [item] }, status: 'ok' };
            },
        });
        const result = await tools.executeTool(
            'get_chart_or_dashboard',
            { kind: 'chart', projectUuid: PROJECT_UUID, slug: SLUG },
            contentWriter(),
        );
        expect(result).toEqual({ item, kind: 'chart', slug: SLUG });
        expect(recordedRequests[0].path).toBe(
            buildCodeChartsPath(PROJECT_UUID),
        );
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('allow');
    });

    it('reads dashboards through the code list route', async () => {
        const { recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                return {
                    results: { dashboards: [{ slug: SLUG }] },
                    status: 'ok',
                };
            },
        });
        await tools.executeTool(
            'get_chart_or_dashboard',
            { kind: 'dashboard', projectUuid: PROJECT_UUID, slug: SLUG },
            contentWriter(),
        );
        expect(recordedRequests[0].path).toBe(
            buildCodeDashboardsPath(PROJECT_UUID),
        );
    });

    it('reads SQL charts through the code list route', async () => {
        const { recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                return {
                    results: { sqlCharts: [{ slug: SLUG }] },
                    status: 'ok',
                };
            },
        });
        await tools.executeTool(
            'get_chart_or_dashboard',
            { kind: 'sql_chart', projectUuid: PROJECT_UUID, slug: SLUG },
            contentWriter(),
        );
        expect(recordedRequests[0].path).toBe(
            buildCodeSqlChartsPath(PROJECT_UUID),
        );
    });

    it('reports a miss without inventing content', async () => {
        const { recordedAudits, tools } = setup({
            fetch: async () => ({
                results: { charts: [] },
                status: 'ok',
            }),
        });
        const error = await tools
            .executeTool(
                'get_chart_or_dashboard',
                { kind: 'chart', projectUuid: PROJECT_UUID, slug: 'missing' },
                contentWriter(),
            )
            .catch((caught: unknown) => caught);
        expect((error as AgentToolError).code).toBe('UPSTREAM_ERROR');
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
    });
});

describe('validate_chart_config', () => {
    const config = {
        chartConfig: { type: 'cartesian' },
        name: 'Revenue',
        spaceSlug: 'marketing',
    };

    it('accepts a schema-valid drawable config', async () => {
        const { recordedAudits, tools } = setup();
        const result = await tools.executeTool(
            'validate_chart_config',
            { config, kind: 'chart', projectUuid: PROJECT_UUID },
            contentWriter(),
        );
        expect(result).toEqual({ kind: 'chart', valid: true });
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('allow');
    });

    it('rejects schema-invalid configs', async () => {
        const deny: ContentSchemaValidator = {
            validate: () => ({
                errors: ['/chartConfig: required property missing'],
                valid: false,
            }),
        };
        const { recordedAudits, tools } = setup({
            validators: { ...allowAllValidators(), chart: deny },
        });
        const error = await tools
            .executeTool(
                'validate_chart_config',
                { config: {}, kind: 'chart', projectUuid: PROJECT_UUID },
                contentWriter(),
            )
            .catch((caught: unknown) => caught);
        expect((error as AgentToolError).code).toBe('INVALID_INPUT');
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
    });

    it('rejects configs the renderer reports as incomplete', async () => {
        const { recordedAudits, tools } = setup({
            renderer: () => ({ complete: false, reason: 'incompleteConfig' }),
        });
        const error = await tools
            .executeTool(
                'validate_chart_config',
                { config, kind: 'chart', projectUuid: PROJECT_UUID },
                contentWriter(),
            )
            .catch((caught: unknown) => caught);
        expect((error as AgentToolError).code).toBe('INVALID_INPUT');
        expect((error as AgentToolError).message).toMatch(/incompleteConfig/);
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('deny');
    });

    it('validates dashboards without a renderer dry-run', async () => {
        let dryRuns = 0;
        const { tools } = setup({
            renderer: () => {
                dryRuns += 1;
                return { complete: true };
            },
        });
        const result = await tools.executeTool(
            'validate_chart_config',
            {
                config: { name: 'Board', spaceSlug: 'marketing', tiles: [] },
                kind: 'dashboard',
                projectUuid: PROJECT_UUID,
            },
            contentWriter(),
        );
        expect(result).toEqual({ kind: 'dashboard', valid: true });
        expect(dryRuns).toBe(0);
    });
});
