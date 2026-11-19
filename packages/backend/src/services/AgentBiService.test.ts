// Slice 3 (TDD red): project-scoped access, catalog search, LLM client env.
import { Ability } from '@casl/ability';
import type { AgentPrincipal } from '@lightdash/agent-bi';
import {
    ForbiddenError,
    NotFoundError,
    OrganizationMemberRole,
    PossibleAbilities,
} from '@lightdash/common';
import type { Account } from '@lightdash/common';
import { describe, expect, it, vi } from 'vitest';
import { AgentBiModel } from '../models/AgentBiModel';
import { AgentBiService } from './AgentBiService';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const makeAccount = (rules: Array<Record<string, unknown>>): Account =>
    ({
        authentication: { type: 'session' },
        isAnonymousUser: () => false,
        isAuthenticated: () => true,
        isJwtUser: () => false,
        isOauthUser: () => false,
        isRegisteredUser: () => true,
        isServiceAccount: () => false,
        organization: {
            createdAt: new Date(),
            name: 'Test Org',
            organizationUuid: ORG,
        },
        user: {
            ability: new Ability<PossibleAbilities>(rules as never[]),
            abilityRules: [],
            id: 'user-id',
            organizationUuid: ORG,
            role: OrganizationMemberRole.VIEWER,
            type: 'registered',
            userUuid: USER,
        },
    }) as unknown as Account;

const godMode = () => makeAccount([{ action: 'manage', subject: 'all' }]);
const emptyAbility = () => makeAccount([]);

const makeProjectModel = (projectUuid: string | string[] = PROJECT) => {
    const known = new Set(
        Array.isArray(projectUuid) ? projectUuid : [projectUuid],
    );
    return {
        get: vi.fn(async (uuid: string) => {
            if (!known.has(uuid)) {
                const error = new Error('Not found');
                (error as { statusCode?: number }).statusCode = 404;
                throw error;
            }
            return { organizationUuid: ORG, projectUuid: uuid };
        }),
    };
};

const makeModel = (
    onQuery?: (
        text: string,
        params: unknown[],
    ) => { rows: Array<Record<string, unknown>> },
) => {
    const queries: Array<{ params: unknown[]; text: string }> = [];
    const agentBiModel = {
        query: async (text: string, params?: unknown[]) => {
            queries.push({ params: params ?? [], text });
            if (onQuery) {
                return onQuery(text, params ?? []);
            }
            return { rows: [] };
        },
    } as unknown as AgentBiModel;
    return { agentBiModel, queries };
};

const makeService = (
    overrides: Partial<{
        agentBiModel: AgentBiModel;
        onQuery: (
            text: string,
            params: unknown[],
        ) => { rows: Array<Record<string, unknown>> };
        projectUuid: string | string[];
        siteUrl: string;
    }> = {},
) => {
    const { agentBiModel, queries } = makeModel(overrides.onQuery);
    const service = new AgentBiService({
        agentBiModel: overrides.agentBiModel ?? agentBiModel,
        projectModel: makeProjectModel(
            overrides.projectUuid ?? PROJECT,
        ) as never,
        siteUrl: overrides.siteUrl ?? 'https://instance.example/',
    });
    return { queries, service };
};

describe('AgentBiService project access', () => {
    it('rejects unknown projects before checking permissions', async () => {
        const { service } = makeService();
        await expect(
            service.requireProjectViewer(godMode(), 'no-such-project'),
        ).rejects.toThrow();
    });

    it('denies project views without permission', async () => {
        const { service } = makeService();
        await expect(
            service.requireProjectViewer(emptyAbility(), PROJECT),
        ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('allows project views with permission and returns the org', async () => {
        const { service } = makeService();
        const access = await service.requireProjectViewer(godMode(), PROJECT);
        expect(access.organizationUuid).toBe(ORG);
    });

    it('denies skills writes without manage permission', async () => {
        const { service } = makeService();
        await expect(
            service.requireSkillsEditor(emptyAbility(), PROJECT),
        ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('allows skills writes with manage permission', async () => {
        const { service } = makeService();
        const access = await service.requireSkillsEditor(godMode(), PROJECT);
        expect(access.organizationUuid).toBe(ORG);
    });

    it('denies thread creation without create permission', async () => {
        const { service } = makeService();
        await expect(
            service.requireThreadCreator(emptyAbility(), PROJECT),
        ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('allows thread creation with manage permission', async () => {
        const { service } = makeService();
        const access = await service.requireThreadCreator(godMode(), PROJECT);
        expect(access.organizationUuid).toBe(ORG);
    });

    it('denies skills reads without view permission', async () => {
        const { service } = makeService();
        await expect(
            service.requireSkillsViewer(emptyAbility(), PROJECT),
        ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('allows skills reads with view permission', async () => {
        const { service } = makeService();
        const access = await service.requireSkillsViewer(godMode(), PROJECT);
        expect(access.organizationUuid).toBe(ORG);
    });
});

describe('AgentBiService catalog search', () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
        content: 'orders status pending',
        explore_name: 'orders',
        field_kind: null,
        field_name: null,
        project_uuid: PROJECT,
        resource_type: 'explore',
        resource_uuid: '11111111-1111-4111-8111-111111111111',
        table_name: null,
        ...overrides,
    });

    it('scopes catalog search to the requested project', async () => {
        const otherProject = '44444444-4444-4444-8444-444444444444';
        const projectHit = row({
            field_kind: 'dimension',
            field_name: 'status',
            resource_type: 'dimension',
            table_name: 'orders',
        });
        const otherProjectHit = row({
            field_kind: 'dimension',
            field_name: 'status',
            project_uuid: otherProject,
            resource_type: 'dimension',
            table_name: 'orders',
        });
        const { queries, service } = makeService({
            onQuery: (text, params) => {
                if (!text.includes('catalog_index')) return { rows: [] };
                const rows = [projectHit, otherProjectHit];
                return {
                    rows: text.includes('WHERE project_uuid = $1')
                        ? rows.filter(
                              (result) => result.project_uuid === params[0],
                          )
                        : rows,
                };
            },
        });
        const visibility = {
            allowedExplores: new Set(['orders']),
            allowedFieldsByExplore: new Map([
                ['orders', new Set(['orders.status'])],
            ]),
        };
        const {
            catalogSearch: { search },
        } = service.buildToolDeps({});
        const hits = (await Reflect.apply(search, undefined, [
            'orders status',
            visibility,
            5,
            PROJECT,
        ])) as Array<{ document: { projectUuid: string } }>;

        expect(queries[0]?.text).toContain('WHERE project_uuid = $1');
        expect(queries[0]?.params).toEqual([PROJECT, 2000]);
        expect(hits.map((hit) => hit.document.projectUuid)).toEqual([PROJECT]);
    });

    it('maps index rows to searchable documents', async () => {
        const visible = row({
            content: 'orders status pending',
            field_kind: 'dimension',
            field_name: 'status',
            resource_type: 'dimension',
            table_name: 'orders',
        });
        const { service } = makeService({
            onQuery: (text) =>
                text.includes('catalog_index')
                    ? {
                          rows: [
                              row(),
                              visible,
                              row({ explore_name: 'payments' }),
                          ],
                      }
                    : { rows: [] },
        });
        const matches = await service.searchCatalogForProject(
            PROJECT,
            'orders status',
            5,
            {
                allowedExplores: new Set(['orders']),
                allowedFieldsByExplore: new Map([
                    ['orders', new Set(['orders.status'])],
                ]),
            },
        );
        expect(matches.map((document) => document.fieldName)).toEqual([
            'status',
        ]);
    });

    it('fails closed when the caller has no authorized explores', async () => {
        const field = row({
            field_kind: 'dimension',
            field_name: 'status',
            resource_type: 'dimension',
            table_name: 'orders',
        });
        const { service } = makeService({
            onQuery: () => ({ rows: [row(), field] }),
        });
        await expect(
            service.searchCatalogForProject(PROJECT, 'orders status'),
        ).resolves.toEqual([]);
    });

    it('returns nothing when nothing matches', async () => {
        const { service } = makeService({
            onQuery: () => ({ rows: [row()] }),
        });
        const matches = await service.searchCatalogForProject(
            PROJECT,
            'zzz-no-such-term',
            5,
        );
        expect(matches).toHaveLength(0);
    });
});

describe('AgentBiService catalog index synchronization', () => {
    it('indexes cached project metadata before building visible explores', async () => {
        const cachedExplore = {
            baseTable: 'orders',
            label: 'Orders',
            name: 'orders',
            tags: ['finance'],
            tables: {
                orders: {
                    dimensions: {
                        status: {
                            description: 'Order status',
                            fieldType: 'dimension',
                            hidden: false,
                            label: 'Status',
                            name: 'status',
                            type: 'string',
                        },
                    },
                    label: 'Orders',
                    metrics: {
                        total: {
                            description: 'Total revenue',
                            fieldType: 'metric',
                            hidden: false,
                            label: 'Total',
                            name: 'total',
                            type: 'sum',
                        },
                    },
                    name: 'orders',
                },
            },
        };
        const findExploresFromCache = vi.fn(async () => ({
            'orders-uuid': cachedExplore,
        }));
        const queries: Array<{ params: unknown[]; text: string }> = [];
        const agentBiModel = {
            query: async (text: string, params?: unknown[]) => {
                queries.push({ params: params ?? [], text });
                if (text.includes('SELECT DISTINCT explore_name')) {
                    return {
                        rows: queries.some(
                            (query) =>
                                query.text.includes('INSERT INTO') &&
                                query.text.includes('catalog_index'),
                        )
                            ? [{ explore_name: 'orders' }]
                            : [],
                    };
                }
                return { rows: [] };
            },
        } as unknown as AgentBiModel;
        const service = new AgentBiService({
            agentBiModel,
            projectModel: { findExploresFromCache } as never,
            siteUrl: 'https://instance.example',
        });

        const names = await service.getCatalogExploreNames(PROJECT);

        expect(findExploresFromCache).toHaveBeenCalledWith(PROJECT, 'uuid');
        expect(names).toEqual(['orders']);
        const upsert = queries.find(
            (query) =>
                query.text.includes('INSERT INTO') &&
                query.text.includes('catalog_index'),
        );
        expect(upsert?.params).toHaveLength(1);
        expect(JSON.stringify(upsert?.params[0])).toContain('Order status');
        expect(JSON.stringify(upsert?.params[0])).toContain('Total revenue');
    });

    it('deletes stale catalog rows within the current project', async () => {
        const staleResourceUuid = '55555555-5555-4555-8555-555555555555';
        const queries: Array<{ params: unknown[]; text: string }> = [];
        const agentBiModel = {
            query: async (text: string, params?: unknown[]) => {
                queries.push({ params: params ?? [], text });
                if (text.includes('SELECT resource_type AS')) {
                    return {
                        rows: [
                            {
                                content: 'old orders field',
                                resourceType: 'dimension',
                                resourceUuid: staleResourceUuid,
                            },
                        ],
                    };
                }
                return { rows: [] };
            },
        } as unknown as AgentBiModel;
        const service = new AgentBiService({
            agentBiModel,
            projectModel: { findExploresFromCache: async () => ({}) } as never,
            siteUrl: 'https://instance.example',
        });

        await service.getCatalogExploreNames(PROJECT);

        const deletion = queries.find((query) =>
            query.text.startsWith('DELETE FROM'),
        );
        expect(deletion?.params).toEqual([
            PROJECT,
            JSON.stringify([
                {
                    resource_type: 'dimension',
                    resource_uuid: staleResourceUuid,
                },
            ]),
        ]);
    });
});

describe('AgentBiService LLM client', () => {
    const envBackup = { ...process.env };

    const restoreEnv = () => {
        for (const key of Object.keys(process.env)) {
            if (!(key in envBackup)) {
                delete process.env[key];
            }
        }
        Object.assign(process.env, envBackup);
    };

    it('fails fast without endpoint configuration', () => {
        const { service } = makeService();
        delete process.env.AGENT_LLM_BASE_URL;
        delete process.env.AGENT_LLM_API_KEY;
        try {
            expect(() => service.buildLlmClient()).toThrow(
                /AGENT_LLM_BASE_URL/,
            );
        } finally {
            restoreEnv();
        }
    });

    it('builds a client from environment', () => {
        process.env.AGENT_LLM_BASE_URL = 'https://llm.example';
        process.env.AGENT_LLM_API_KEY = 'test-key';
        process.env.AGENT_LLM_MODEL = 'mock-model';
        try {
            const { service } = makeService();
            const client = service.buildLlmClient();
            expect(typeof client.complete).toBe('function');
        } finally {
            restoreEnv();
        }
    });
});

describe('AgentBiService thread turns', () => {
    const THREAD = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const threadRow = (overrides: Record<string, unknown> = {}) => ({
        created_at: '2026-01-02T03:04:05.000Z',
        created_by: '33333333-3333-4333-8333-333333333333',
        organization_uuid: ORG,
        project_uuid: PROJECT,
        thread_uuid: THREAD,
        title: 'Test thread',
        updated_at: '2026-01-02T03:04:05.000Z',
        ...overrides,
    });
    const scriptedLlm = (
        script: Array<{
            text?: string;
            toolCalls?: Array<{ arguments: string; id: string; name: string }>;
        }>,
    ) => {
        const calls: unknown[] = [];
        let index = 0;
        return {
            calls,
            client: {
                complete: async (input: unknown) => {
                    calls.push(input);
                    const turn = script[Math.min(index, script.length - 1)];
                    index += 1;
                    return {
                        content: turn?.text ?? null,
                        finishReason: 'stop',
                        toolCalls: turn?.toolCalls ?? [],
                        usage: { completionTokens: 1, promptTokens: 2 },
                    };
                },
            },
        };
    };
    const principal: AgentPrincipal = {
        ability: { can: () => true },
        authType: 'session',
        cacheKey: 'turn-test',
        organizationUuid: ORG,
        userAttributesHash: 'abcd1234',
        userUuid: '33333333-3333-4333-8333-333333333333',
    };

    const accessOf = (userUuid: string) => ({
        organizationUuid: ORG,
        requesterUuid: userUuid,
    });

    let messageSeq = 0;
    const setupTurn = (
        script: Array<{
            text?: string;
            toolCalls?: Array<{ arguments: string; id: string; name: string }>;
        }>,
        queued: Array<Array<Record<string, unknown>>>,
    ) => {
        const queries: Array<{ params: unknown[]; text: string }> = [];
        const queue = [...queued];
        const { service } = makeService({
            onQuery: (text, params) => {
                queries.push({ params, text });
                if (text.startsWith('INSERT INTO "agent_ext"."messages"')) {
                    messageSeq += 1;
                    const [threadUuid, role, content] = params as [
                        string,
                        string,
                        string,
                    ];
                    return {
                        rows: [
                            {
                                content,
                                created_at: '2026-01-02T03:04:05.000Z',
                                message_uuid: `m-new-${messageSeq}`,
                                role,
                                thread_uuid: threadUuid,
                            },
                        ],
                    };
                }
                return { rows: queue.shift() ?? [] };
            },
        });
        const { client } = scriptedLlm(script);
        return { queries, service, client };
    };

    it('runs a text turn and persists the exchange', async () => {
        const { queries, service, client } = setupTurn(
            [{ text: 'Revenue is up.' }],
            [
                [threadRow()],
                [threadRow()],
                [threadRow()],
                [],
                [{ skill_uuid: 's-1' }],
                [],
                [threadRow()],
            ],
        );
        const events: Array<{ type: string }> = [];
        const outcome = await service.runThreadTurn({
            access: accessOf(principal.userUuid),
            llm: client as never,
            onEvent: (event) => {
                events.push(event as { type: string });
            },
            principal,
            projectUuid: PROJECT,
            threadUuid: THREAD,
            userText: 'How is revenue?',
        });
        expect(outcome.status).toBe('completed');
        expect(outcome.text).toBe('Revenue is up.');
        expect(events.map((event) => event.type)).toContain('text_delta');
        const inserts = queries.filter((query) =>
            query.text.includes('INSERT INTO "agent_ext"."messages"'),
        );
        expect(inserts).toHaveLength(2);
    });

    it('suspends on run_sql and records an approval request', async () => {
        const { queries, service, client } = setupTurn(
            [
                {
                    toolCalls: [
                        {
                            arguments: '{"sql":"SELECT 1"}',
                            id: 'call-1',
                            name: 'run_sql',
                        },
                    ],
                },
            ],
            [
                [threadRow()],
                [threadRow()],
                [threadRow()],
                [],
                [{ skill_uuid: 's-1' }],
                [],
                [threadRow()],
            ],
        );
        const events: Array<{ type: string }> = [];
        const outcome = await service.runThreadTurn({
            access: accessOf(principal.userUuid),
            llm: client as never,
            onEvent: (event) => {
                events.push(event as { type: string });
            },
            principal,
            projectUuid: PROJECT,
            threadUuid: THREAD,
            userText: 'Run this SQL.',
        });
        expect(outcome.status).toBe('approval_required');
        expect(events.map((event) => event.type)).toContain(
            'approval_required',
        );
        expect(
            queries.some((query) =>
                query.text.includes('INSERT INTO "agent_ext"."messages"'),
            ),
        ).toBe(true);
    });

    const approvalRow = (overrides: Record<string, unknown> = {}) => ({
        content: JSON.stringify({
            decidedBy: null,
            input: { sql: 'SELECT 1' },
            kind: 'approval_request',
            requestedBy: '33333333-3333-4333-8333-333333333333',
            status: 'approved',
            tool: 'run_sql',
            ...overrides,
        }),
        created_at: '2026-01-02T03:04:05.000Z',
        message_uuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaa01',
        role: 'assistant',
        thread_uuid: THREAD,
    });

    it('rejects resume with a mismatched tool', async () => {
        const { service, client } = setupTurn(
            [],
            [[threadRow()], [approvalRow()], [threadRow()]],
        );
        await expect(
            service.runThreadTurn({
                access: accessOf(principal.userUuid),
                llm: client as never,
                onEvent: () => {},
                principal,
                projectUuid: PROJECT,
                resumeApproved: {
                    approvalUuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaa01',
                    input: { sql: 'SELECT 1' },
                    tool: 'other_tool',
                },
                threadUuid: THREAD,
            }),
        ).rejects.toThrowError(ForbiddenError);
    });

    it('rejects resume when the approved view context has changed', async () => {
        const { service, client } = setupTurn(
            [],
            [
                [threadRow()],
                [
                    approvalRow({
                        context: {
                            pinnedContext: {
                                kind: 'dashboard',
                                slug: 'revenue',
                            },
                            runtimeOverrides: {
                                parameters: { currency: 'EUR' },
                            },
                        },
                    }),
                ],
                [threadRow()],
            ],
        );
        await expect(
            service.runThreadTurn({
                access: accessOf(principal.userUuid),
                llm: client as never,
                onEvent: () => {},
                pinnedContext: { kind: 'dashboard', slug: 'revenue' },
                principal,
                projectUuid: PROJECT,
                resumeApproved: {
                    approvalUuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaa01',
                    input: { sql: 'SELECT 1' },
                    tool: 'run_sql',
                },
                runtimeOverrides: { parameters: { currency: 'USD' } },
                threadUuid: THREAD,
            }),
        ).rejects.toThrowError(ForbiddenError);
    });

    it('rejects resume of a pending approval', async () => {
        const { service, client } = setupTurn(
            [],
            [
                [threadRow()],
                [approvalRow({ status: 'pending' })],
                [threadRow()],
            ],
        );
        await expect(
            service.runThreadTurn({
                access: accessOf(principal.userUuid),
                llm: client as never,
                onEvent: () => {},
                principal,
                projectUuid: PROJECT,
                resumeApproved: {
                    approvalUuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaa01',
                    input: { sql: 'SELECT 1' },
                    tool: 'run_sql',
                },
                threadUuid: THREAD,
            }),
        ).rejects.toThrowError(ForbiddenError);
    });

    it('rejects resume of an unknown approval', async () => {
        const { service, client } = setupTurn([], [[threadRow()], []]);
        await expect(
            service.runThreadTurn({
                access: accessOf(principal.userUuid),
                llm: client as never,
                onEvent: () => {},
                principal,
                projectUuid: PROJECT,
                resumeApproved: {
                    approvalUuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaa01',
                    input: { sql: 'SELECT 1' },
                    tool: 'run_sql',
                },
                threadUuid: THREAD,
            }),
        ).rejects.toThrowError(ForbiddenError);
    });
});

describe('AgentBiService resolveThreadApproval', () => {
    const THREAD = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const APPROVAL = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaa01';
    const principal = {
        ability: { can: () => true },
        authType: 'session',
        cacheKey: 'turn-test',
        organizationUuid: '11111111-1111-4111-8111-111111111111',
        userAttributesHash: 'abcd1234',
        userUuid: '33333333-3333-4333-8333-333333333333',
    } as const;
    const threadRow = () => ({
        created_at: '2026-01-02T03:04:05.000Z',
        created_by: principal.userUuid,
        organization_uuid: '11111111-1111-4111-8111-111111111111',
        project_uuid: '22222222-2222-4222-8222-222222222222',
        thread_uuid: THREAD,
        title: 'Test thread',
        updated_at: '2026-01-02T03:04:05.000Z',
    });
    const approvalRow = (status: string, tool = 'run_sql') => ({
        content: JSON.stringify({
            decidedBy: null,
            input: { sql: 'SELECT 1' },
            kind: 'approval_request',
            requestedBy: principal.userUuid,
            status,
            tool,
        }),
        created_at: '2026-01-02T03:04:05.000Z',
        message_uuid: APPROVAL,
        role: 'system',
        thread_uuid: THREAD,
    });
    const setupApproval = (queued: Array<Array<Record<string, unknown>>>) => {
        const queue = [...queued];
        const { service } = makeService({
            onQuery: () => ({ rows: queue.shift() ?? [] }),
        });
        return { service };
    };

    it('approves a pending request from the thread owner', async () => {
        const { service } = setupApproval([
            [threadRow()],
            [approvalRow('pending')],
            [threadRow()],
            [{ thread_uuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }],
            [threadRow()],
            [
                {
                    ...approvalRow('approved', 'run_sql'),
                    content: JSON.stringify({
                        decidedBy: principal.userUuid,
                        input: { sql: 'SELECT 1' },
                        kind: 'approval_request',
                        requestedBy: principal.userUuid,
                        status: 'approved',
                        tool: 'run_sql',
                    }),
                },
            ],
        ]);
        const result = await service.resolveThreadApproval(
            godMode(),
            principal,
            '22222222-2222-4222-8222-222222222222',
            THREAD,
            APPROVAL,
            'approved',
        );
        expect(result.status).toBe('approved');
        expect(result.tool).toBe('run_sql');
    });

    it('hides threads from other projects as not found', async () => {
        const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
        const queue: Array<Array<Record<string, unknown>>> = [[threadRow()]];
        const queued = [...queue];
        const { service } = makeService({
            onQuery: () => ({ rows: queued.shift() ?? [] }),
            projectUuid: [PROJECT, OTHER_PROJECT],
        });
        await expect(
            service.resolveThreadApproval(
                godMode(),
                principal,
                OTHER_PROJECT,
                THREAD,
                APPROVAL,
                'approved',
            ),
        ).rejects.toThrowError(NotFoundError);
    });
});

describe('AgentBiService verifySpaceAccess', () => {
    const SPACE_UUID = '55555555-5555-4555-8555-555555555555';
    const userPrincipal = {
        ability: { can: () => false },
        authType: 'session' as const,
        cacheKey: 'user:33333333-3333-4333-8333-333333333333',
        organizationUuid: '11111111-1111-4111-8111-111111111111',
        userAttributesHash: 'test-hash',
        userUuid: '33333333-3333-4333-8333-333333333333',
    };

    it('denies access to a private space when the user has no direct or group share', async () => {
        const { service } = makeService({
            onQuery: (text) => {
                if (text.includes('FROM spaces s')) {
                    return {
                        rows: [
                            {
                                project_member_access_role: null,
                                space_uuid: SPACE_UUID,
                            },
                        ],
                    };
                }
                return { rows: [] };
            },
        });
        const { verifySpaceAccess } = service.buildToolDeps({});
        await expect(
            verifySpaceAccess?.(PROJECT, 'private-space', userPrincipal),
        ).resolves.toEqual({
            exists: false,
            isPublic: false,
            writable: false,
        });
    });

    it('returns read-only access for a private space viewer and writable for a group editor', async () => {
        const { service: viewerService } = makeService({
            onQuery: (text) => {
                if (text.includes('FROM spaces s')) {
                    return {
                        rows: [
                            {
                                project_member_access_role: null,
                                space_uuid: SPACE_UUID,
                            },
                        ],
                    };
                }
                if (text.includes('space_user_access')) {
                    return { rows: [{ space_role: 'viewer' }] };
                }
                return { rows: [] };
            },
        });
        await expect(
            viewerService
                .buildToolDeps({})
                .verifySpaceAccess?.(PROJECT, 'private-space', userPrincipal),
        ).resolves.toEqual({
            exists: true,
            isPublic: false,
            writable: false,
        });

        const { service: groupEditorService } = makeService({
            onQuery: (text) => {
                if (text.includes('FROM spaces s')) {
                    return {
                        rows: [
                            {
                                project_member_access_role: null,
                                space_uuid: SPACE_UUID,
                            },
                        ],
                    };
                }
                if (
                    text.includes('space_group_access') &&
                    text.includes('JOIN users u ON u.user_id = gm.user_id') &&
                    text.includes('u.user_uuid = $2')
                ) {
                    return { rows: [{ space_role: 'editor' }] };
                }
                return { rows: [] };
            },
        });
        await expect(
            groupEditorService
                .buildToolDeps({})
                .verifySpaceAccess?.(PROJECT, 'private-space', userPrincipal),
        ).resolves.toEqual({
            exists: true,
            isPublic: false,
            writable: true,
        });
    });

    it('distinguishes read-only vs writable public spaces', async () => {
        const { service: roPublicService } = makeService({
            onQuery: (text) => {
                if (text.includes('FROM spaces s')) {
                    return {
                        rows: [
                            {
                                project_member_access_role: 'viewer',
                                space_uuid: SPACE_UUID,
                            },
                        ],
                    };
                }
                return { rows: [] };
            },
        });
        await expect(
            roPublicService
                .buildToolDeps({})
                .verifySpaceAccess?.(PROJECT, 'public-ro', userPrincipal),
        ).resolves.toEqual({
            exists: true,
            isPublic: true,
            writable: false,
        });

        const { service: rwPublicService } = makeService({
            onQuery: (text) => {
                if (text.includes('FROM spaces s')) {
                    return {
                        rows: [
                            {
                                project_member_access_role: 'editor',
                                space_uuid: SPACE_UUID,
                            },
                        ],
                    };
                }
                return { rows: [] };
            },
        });
        await expect(
            rwPublicService
                .buildToolDeps({})
                .verifySpaceAccess?.(PROJECT, 'public-rw', userPrincipal),
        ).resolves.toEqual({
            exists: true,
            isPublic: true,
            writable: true,
        });
    });
});
