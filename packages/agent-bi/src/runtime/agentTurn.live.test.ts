// Live integration (Slice 3): agent turn over real PG with a scripted LLM.
// Thread/message/skill persistence, approval pause + resume, tool execution.
// Runs ONLY when AGENT_BI_TEST_DATABASE_URL is set (Sandbox/CI); the suite
// skips otherwise so workstation runs never need a database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { defaultCapabilityToggles } from '../policy/capabilityPolicy';
import { runAgentTurn, type OrchestratorEvent } from './agentOrchestrator';
import {
    listPendingApprovals,
    requestApproval,
    resolveApproval,
} from './approvalGate';
import type { LlmChatResult } from './llmClient';
import { createSkillStore } from './skillRepository';
import { createThreadStore, type ThreadAccess } from './threadRepository';

const DATABASE_URL = process.env['AGENT_BI_TEST_DATABASE_URL'] ?? '';
const hasDatabase = DATABASE_URL.length > 0;

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

type PgClient = {
    end(): Promise<void>;
    query(
        text: string,
        params?: unknown[],
    ): Promise<{ rows: Array<Record<string, unknown>> }>;
};

let pg: PgClient | undefined;

const db = async (): Promise<PgClient> => {
    if (pg) {
        return pg;
    }
    const { Client } = await import('pg');
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    pg = client as unknown as PgClient;
    return pg;
};

afterAll(async () => {
    await pg?.end();
    pg = undefined;
});

beforeAll(async () => {
    if (!hasDatabase) {
        return;
    }
    const client = await db();
    const { migrateUp } = await import('../db/migrate');
    await migrateUp({ query: (text: string) => client.query(text) });
});

const access = (): ThreadAccess => ({
    isOrgAdmin: true,
    organizationUuid: ORG,
    requesterUuid: USER,
});

const principal = (): AgentPrincipal => ({
    ability: { can: () => true },
    authType: 'session',
    cacheKey: 'agent-turn-live',
    organizationUuid: ORG,
    userAttributesHash: 'live1234',
    userUuid: USER,
});

const textResult = (text: string): LlmChatResult => ({
    content: text,
    finishReason: 'stop',
    toolCalls: [],
    usage: { completionTokens: 3, promptTokens: 10 },
});

const toolResult = (id: string, name: string, args: string): LlmChatResult => ({
    content: null,
    finishReason: 'tool_calls',
    toolCalls: [{ arguments: args, id, name }],
    usage: { completionTokens: 4, promptTokens: 12 },
});

const scriptedLlm = (results: LlmChatResult[]) => {
    let index = 0;
    return {
        complete: async () => {
            const result = results[Math.min(index, results.length - 1)];
            index += 1;
            if (result === undefined) {
                throw new Error('script exhausted');
            }
            return result;
        },
    };
};

describe.skipIf(!hasDatabase)('agent turn live integration', () => {
    it('persists threads, messages and skills over real SQL', async () => {
        const client = await db();
        const query = (text: string, params?: unknown[]) =>
            client.query(text, params);
        const threads = createThreadStore({ query });
        const skills = createSkillStore({ query });

        const thread = await threads.createThread({
            createdBy: USER,
            organizationUuid: ORG,
            projectUuid: PROJECT,
            title: 'Live integration',
        });
        expect(thread.threadUuid).toMatch(/^[0-9a-f-]{36}$/i);

        const fetched = await threads.getThread(thread.threadUuid, access());
        expect(fetched?.threadUuid).toBe(thread.threadUuid);

        await threads.createMessage(
            {
                content: 'Run this SQL.',
                role: 'user',
                threadUuid: thread.threadUuid,
            },
            access(),
        );
        await threads.createMessage(
            {
                content: 'Working on it.',
                role: 'assistant',
                threadUuid: thread.threadUuid,
            },
            access(),
        );
        const messages = await threads.listMessages(
            thread.threadUuid,
            access(),
        );
        expect(messages).toHaveLength(2);

        const listed = await threads.listThreads({
            ...access(),
            projectUuid: PROJECT,
        });
        expect(
            listed.some(
                (candidate) => candidate.threadUuid === thread.threadUuid,
            ),
        ).toBe(true);

        const slug = `live-skill-${Date.now()}`;
        const skill = await skills.createSkill({
            manifest: { description: 'Live skill' },
            projectUuid: PROJECT,
            slug,
        });
        expect(skill.slug).toBe(slug);

        const bySlug = await skills.getSkillBySlug({
            projectUuid: PROJECT,
            slug,
        });
        expect(bySlug?.skillUuid).toBe(skill.skillUuid);

        const updated = await skills.updateSkill({
            patch: { version: '2' },
            projectUuid: PROJECT,
            skillUuid: skill.skillUuid,
        });
        expect(updated.version).toBe('2');

        await skills.deleteSkill({
            projectUuid: PROJECT,
            skillUuid: skill.skillUuid,
        });
        const gone = await skills.getSkillBySlug({
            projectUuid: PROJECT,
            slug,
        });
        expect(gone).toBeNull();
    });

    it('pauses run_sql for approval, resumes approved and persists the transcript', async () => {
        const client = await db();
        const query = (text: string, params?: unknown[]) =>
            client.query(text, params);
        const threads = createThreadStore({ query });

        const thread = await threads.createThread({
            createdBy: USER,
            organizationUuid: ORG,
            projectUuid: PROJECT,
            title: 'Live approval turn',
        });
        await threads.createMessage(
            {
                content: 'Run this SQL.',
                role: 'user',
                threadUuid: thread.threadUuid,
            },
            access(),
        );

        const requester = {
            requestApproval: async (tool: string, input: unknown) => {
                const request = await requestApproval(threads, {
                    access: access(),
                    input,
                    threadUuid: thread.threadUuid,
                    tool,
                });
                return { approvalUuid: request.approvalUuid };
            },
        };

        const executed: Array<{ input: unknown; tool: string }> = [];
        const events: OrchestratorEvent[] = [];
        const paused = await runAgentTurn({
            approvals: requester,
            catalogMatches: [],
            llm: scriptedLlm([
                toolResult('call_1', 'run_sql', '{"sql":"SELECT 1"}'),
            ]),
            maxTurns: 4,
            model: 'mock-model',
            pinnedContext: null,
            policyToggles: defaultCapabilityToggles(),
            principal: principal(),
            projectUuid: PROJECT,
            runtimeOverrides: null,
            skills: [],
            tools: {
                execute: async () => {
                    throw new Error('must not execute without approval');
                },
            },
            onEvent: (event) => {
                events.push(event);
            },
            userText: 'Run this SQL.',
        });
        expect(paused.status).toBe('approval_required');
        expect(paused.approvalUuid).toBeDefined();
        const kinds = events.map((event) => event.type);
        expect(kinds).toContain('status');
        expect(kinds).toContain('approval_required');

        const pending = listPendingApprovals(
            await threads.listMessages(thread.threadUuid, access()),
        );
        expect(pending).toHaveLength(1);
        expect(pending[0]?.approvalUuid).toBe(paused.approvalUuid);

        const decided = await resolveApproval(threads, {
            access: access(),
            approvalUuid: paused.approvalUuid ?? '',
            decision: 'approved',
        });
        expect(decided.status).toBe('approved');

        const resumedEvents: OrchestratorEvent[] = [];
        const resumed = await runAgentTurn({
            approvals: requester,
            catalogMatches: [],
            llm: scriptedLlm([textResult('Done.')]),
            maxTurns: 4,
            model: 'mock-model',
            pinnedContext: null,
            policyToggles: defaultCapabilityToggles(),
            principal: principal(),
            projectUuid: PROJECT,
            runtimeOverrides: null,
            skills: [],
            tools: {
                execute: async (tool: string, input: unknown) => {
                    executed.push({ input, tool });
                    return { rows: [{ n: 1 }] };
                },
            },
            onEvent: (event) => {
                resumedEvents.push(event);
            },
            resumeApproved: {
                approvalUuid: paused.approvalUuid ?? '',
                input: { sql: 'SELECT 1' },
                tool: 'run_sql',
            },
            userText: 'Run this SQL.',
        });
        expect(resumed.status).toBe('completed');
        expect(executed).toEqual([
            { input: { sql: 'SELECT 1' }, tool: 'run_sql' },
        ]);
        expect(resumedEvents.map((event) => event.type)).toContain('done');

        await threads.createMessage(
            {
                content: resumed.text ?? '',
                role: 'assistant',
                threadUuid: thread.threadUuid,
            },
            access(),
        );
        const transcript = await threads.listMessages(
            thread.threadUuid,
            access(),
        );
        expect(transcript.length).toBeGreaterThanOrEqual(3);
    });
});
