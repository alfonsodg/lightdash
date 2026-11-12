// Content tool contract tests (Phase 4): cross-cutting guarantees over the
// canonical `/code/*` routes. Fakes only at the HTTP, validator and renderer
// seams; no live server, no database.

import { describe, expect, it } from 'vitest';
import type { AuditQueryClient } from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { defaultCapabilityToggles } from '../policy/capabilityPolicy';
import { AgentToolError } from '../tools/agentToolTypes';
import {
    buildCodeChartItemPath,
    buildCodeDashboardItemPath,
    type ContentFetch,
} from './contentFetch';
import {
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
    cacheKey: 'contract-content-writer',
    organizationUuid: ORG_UUID,
    userAttributesHash: 'abcd1234',
    userUuid: USER_UUID,
});

const viewer = (): AgentPrincipal => ({
    ability: { can: () => false },
    authType: 'session',
    cacheKey: 'contract-content-viewer',
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
        policyContext: { toggles: defaultCapabilityToggles() },
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

const sqlChart = {
    chartKind: 'cartesian',
    config: { type: 'cartesian' },
    limit: 100,
    name: 'SQL revenue',
    spaceSlug: 'marketing',
    sql: 'SELECT status FROM orders',
};

describe('content contract: idempotent upsert shape', () => {
    it('retries a chart upsert on the same slug path with an identical body', async () => {
        const { recordedAudits, recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                return {
                    results: { charts: [{ action: 'upsert' }] },
                    status: 'ok',
                };
            },
        });
        const input = {
            chart: { name: 'Revenue', spaceSlug: 'marketing' },
            projectUuid: PROJECT_UUID,
            slug: SLUG,
        };
        const first = await tools.executeTool(
            'upsert_chart_as_code',
            input,
            contentWriter(),
        );
        const second = await tools.executeTool(
            'upsert_chart_as_code',
            input,
            contentWriter(),
        );
        expect(first).toMatchObject({ slug: SLUG });
        expect(second).toMatchObject({ slug: SLUG });
        expect(recordedRequests).toHaveLength(2);
        expect(recordedRequests[0].method).toBe('POST');
        expect(recordedRequests[0].path).toBe(
            buildCodeChartItemPath(PROJECT_UUID, SLUG),
        );
        expect(recordedRequests[1].path).toBe(recordedRequests[0].path);
        expect(recordedRequests[1].body).toEqual(recordedRequests[0].body);
        expect(recordedAudits).toHaveLength(2);
        for (const row of recordedAudits) {
            expect(verdictOf(row.params)).toBe('allow');
        }
    });

    it('retries a dashboard upsert on the same slug path', async () => {
        const { recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                return {
                    results: { dashboards: [{ action: 'upsert' }] },
                    status: 'ok',
                };
            },
        });
        const input = {
            dashboard: { name: 'Board', spaceSlug: 'marketing', tiles: [] },
            projectUuid: PROJECT_UUID,
            slug: SLUG,
        };
        await tools.executeTool(
            'upsert_dashboard_as_code',
            input,
            contentWriter(),
        );
        await tools.executeTool(
            'upsert_dashboard_as_code',
            input,
            contentWriter(),
        );
        expect(recordedRequests).toHaveLength(2);
        expect(recordedRequests[0].path).toBe(
            buildCodeDashboardItemPath(PROJECT_UUID, SLUG),
        );
        expect(recordedRequests[1].path).toBe(recordedRequests[0].path);
        expect(recordedRequests[1].body).toEqual(recordedRequests[0].body);
    });
});

describe('content contract: unknown tools', () => {
    it('rejects unknown tools without auditing', async () => {
        const { recordedAudits, recordedRequests, tools } = setup();
        const error = await tools
            .executeTool(
                'publish_everything',
                { projectUuid: PROJECT_UUID },
                contentWriter(),
            )
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AgentToolError);
        expect((error as AgentToolError).code).toBe('UNKNOWN_TOOL');
        expect(recordedRequests).toHaveLength(0);
        expect(recordedAudits).toHaveLength(0);
    });
});

describe('content contract: viewer denied on upserts', () => {
    it('denies chart, dashboard and SQL upserts with one deny row each', async () => {
        const chartSetup = setup();
        const chartError = await chartSetup.tools
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
        expect((chartError as AgentToolError).code).toBe('POLICY_DENIED');
        expect(chartSetup.recordedRequests).toHaveLength(0);
        expect(chartSetup.recordedAudits).toHaveLength(1);
        expect(verdictOf(chartSetup.recordedAudits[0].params)).toBe('deny');

        const dashboardSetup = setup();
        const dashboardError = await dashboardSetup.tools
            .executeTool(
                'upsert_dashboard_as_code',
                {
                    dashboard: {
                        name: 'Board',
                        spaceSlug: 'marketing',
                        tiles: [],
                    },
                    projectUuid: PROJECT_UUID,
                    slug: SLUG,
                },
                viewer(),
            )
            .catch((caught: unknown) => caught);
        expect((dashboardError as AgentToolError).code).toBe('POLICY_DENIED');
        expect(dashboardSetup.recordedRequests).toHaveLength(0);
        expect(dashboardSetup.recordedAudits).toHaveLength(1);
        expect(verdictOf(dashboardSetup.recordedAudits[0].params)).toBe('deny');

        const sqlSetup = setup();
        const sqlError = await sqlSetup.tools
            .executeTool(
                'upsert_sql_chart_as_code',
                {
                    approvalToken: 'approve-1',
                    projectUuid: PROJECT_UUID,
                    slug: SLUG,
                    sqlChart,
                },
                viewer(),
            )
            .catch((caught: unknown) => caught);
        expect((sqlError as AgentToolError).code).toBe('POLICY_DENIED');
        expect(sqlSetup.recordedRequests).toHaveLength(0);
        expect(sqlSetup.recordedAudits).toHaveLength(1);
        expect(verdictOf(sqlSetup.recordedAudits[0].params)).toBe('deny');
    });
});

describe('content contract: SQL chart approval gate', () => {
    it('requires a bound human approval token', async () => {
        const { recordedRequests, tools } = setup();
        const error = await tools
            .executeTool(
                'upsert_sql_chart_as_code',
                { projectUuid: PROJECT_UUID, slug: SLUG, sqlChart },
                contentWriter(),
            )
            .catch((caught: unknown) => caught);
        expect((error as AgentToolError).code).toBe('GUARD_DENIED');
        expect((error as AgentToolError).reason).toBe('MISSING_APPROVAL');
        expect(recordedRequests).toHaveLength(0);
    });

    it('rejects a mismatched approval token', async () => {
        const { recordedRequests, tools } = setup();
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
        expect(recordedRequests).toHaveLength(0);
    });

    it('posts approved read-only SQL without leaking the token', async () => {
        const { recordedAudits, recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                return {
                    results: { sqlCharts: [{ action: 'upsert' }] },
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
        expect(recordedRequests[0].path).not.toMatch(/\/saved/);
        const body = recordedRequests[0].body as Record<string, unknown>;
        expect(body).not.toHaveProperty('approvalToken');
        expect(recordedAudits).toHaveLength(1);
        expect(verdictOf(recordedAudits[0].params)).toBe('allow');
    });
});

describe('content contract: deprecated routes absent', () => {
    it('only touches canonical code routes across all five tools', async () => {
        const { recordedRequests, tools } = setup({
            fetch: async (request) => {
                recordedRequests.push(request);
                if (request.method === 'GET') {
                    return {
                        results: { charts: [{ slug: SLUG }] },
                        status: 'ok',
                    };
                }
                return { results: { action: 'upsert' }, status: 'ok' };
            },
        });
        const principal = contentWriter();
        await tools.executeTool(
            'upsert_chart_as_code',
            {
                chart: { name: 'Revenue', spaceSlug: 'marketing' },
                projectUuid: PROJECT_UUID,
                slug: SLUG,
            },
            principal,
        );
        await tools.executeTool(
            'upsert_sql_chart_as_code',
            {
                approvalToken: 'approve-1',
                projectUuid: PROJECT_UUID,
                slug: SLUG,
                sqlChart,
            },
            principal,
        );
        await tools.executeTool(
            'upsert_dashboard_as_code',
            {
                dashboard: { name: 'Board', spaceSlug: 'marketing', tiles: [] },
                projectUuid: PROJECT_UUID,
                slug: SLUG,
            },
            principal,
        );
        await tools.executeTool(
            'get_chart_or_dashboard',
            { kind: 'chart', projectUuid: PROJECT_UUID, slug: SLUG },
            principal,
        );
        await tools.executeTool(
            'validate_chart_config',
            {
                config: { name: 'Revenue', spaceSlug: 'marketing' },
                kind: 'chart',
                projectUuid: PROJECT_UUID,
            },
            principal,
        );
        expect(recordedRequests.length).toBeGreaterThan(0);
        for (const request of recordedRequests) {
            expect(request.method === 'GET' || request.method === 'POST').toBe(
                true,
            );
            expect(request.path).toMatch(
                `/api/v1/projects/${PROJECT_UUID}/code/`,
            );
            expect(request.path).not.toContain('/saved');
            expect(request.path).not.toContain('chart-and-results');
        }
    });
});
