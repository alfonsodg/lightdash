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

    it('maps index rows to searchable documents', async () => {
        const { service } = makeService({
            onQuery: (text) =>
                text.includes('catalog_index')
                    ? { rows: [row(), row({ explore_name: 'payments' })] }
                    : { rows: [] },
        });
        const matches = await service.searchCatalogForProject(
            PROJECT,
            'orders status',
            5,
        );
        expect(matches.map((document) => document.exploreName)).toContain(
            'orders',
        );
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
        role: 'assistant',
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
