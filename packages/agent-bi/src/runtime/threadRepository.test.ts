// Slice 1 (TDD red): thread/message repository over agent_ext with strict
// ownership. Fake client records SQL; no database here.
import { describe, expect, it } from 'vitest';
import {
    createThreadStore,
    isThreadAccessible,
    ThreadStoreError,
    type ThreadQueryClient,
} from './threadRepository';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4434-8444-444444444444';

const setup = () => {
    const queries: Array<{ params: unknown[]; text: string }> = [];
    const queued: Array<Array<Record<string, unknown>>> = [];
    const db: ThreadQueryClient = {
        query: async (text: string, params?: unknown[]) => {
            queries.push({ params: params ?? [], text });
            return { rows: queued.shift() ?? [] };
        },
    };
    return { db, queries, queued };
};

const threadRow = (overrides: Record<string, unknown> = {}) => ({
    created_at: '2026-01-02T03:04:05.000Z',
    created_by: USER,
    organization_uuid: ORG,
    project_uuid: PROJECT,
    thread_uuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    title: 'Revenue questions',
    updated_at: '2026-01-02T03:04:05.000Z',
    ...overrides,
});

describe('isThreadAccessible', () => {
    it('allows the owner', () => {
        expect(
            isThreadAccessible(
                { createdBy: USER },
                { isOrgAdmin: false, requesterUuid: USER },
            ),
        ).toBe(true);
    });
    it('denies other users', () => {
        expect(
            isThreadAccessible(
                { createdBy: USER },
                { isOrgAdmin: false, requesterUuid: OTHER },
            ),
        ).toBe(false);
    });
    it('denies records without an owner even to anyone', () => {
        expect(
            isThreadAccessible(
                { createdBy: null },
                { isOrgAdmin: false, requesterUuid: USER },
            ),
        ).toBe(false);
    });
    it('allows org admins auditing any thread', () => {
        expect(
            isThreadAccessible(
                { createdBy: USER },
                { isOrgAdmin: true, requesterUuid: OTHER },
            ),
        ).toBe(true);
    });
});

describe('thread store', () => {
    it('creates a thread scoped to org, project and owner', async () => {
        const { db, queries, queued } = setup();
        queued.push([threadRow()]);
        const store = createThreadStore(db);
        const created = await store.createThread({
            createdBy: USER,
            organizationUuid: ORG,
            projectUuid: PROJECT,
            title: 'Revenue questions',
        });
        expect(created.threadUuid).toBe('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
        expect(created.projectUuid).toBe(PROJECT);
        expect(queries[0]?.text).toContain('INSERT INTO "agent_ext"."threads"');
        expect(queries[0]?.params.slice(0, 4)).toEqual([
            ORG,
            PROJECT,
            USER,
            'Revenue questions',
        ]);
    });

    it('returns null for a missing thread', async () => {
        const { db } = setup();
        const store = createThreadStore(db);
        await expect(
            store.getThread('bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', {
                isOrgAdmin: false,
                organizationUuid: ORG,
                requesterUuid: USER,
            }),
        ).resolves.toBeNull();
    });

    it('rejects forbidden threads without leaking them', async () => {
        const { db, queued } = setup();
        queued.push([threadRow()]);
        const store = createThreadStore(db);
        await expect(
            store.getThread('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', {
                isOrgAdmin: false,
                organizationUuid: ORG,
                requesterUuid: OTHER,
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('lists only the requester threads unless admin', async () => {
        const { db, queries, queued } = setup();
        queued.push([threadRow(), threadRow()]);
        const store = createThreadStore(db);
        const rows = await store.listThreads({
            isOrgAdmin: false,
            organizationUuid: ORG,
            projectUuid: PROJECT,
            requesterUuid: USER,
        });
        expect(rows).toHaveLength(2);
        expect(queries[0]?.text).toContain('created_by');
    });

    it('writes a message only inside an accessible thread', async () => {
        const { db, queries, queued } = setup();
        queued.push([threadRow()]);
        queued.push([
            {
                content: 'Hello',
                created_at: '2026-01-02T03:05:05.000Z',
                message_uuid: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
                role: 'user',
                thread_uuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
            },
        ]);
        const store = createThreadStore(db);
        const message = await store.createMessage(
            {
                content: 'Hello',
                role: 'user',
                threadUuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
            },
            { isOrgAdmin: false, organizationUuid: ORG, requesterUuid: USER },
        );
        expect(message.messageUuid).toBe(
            'cccccccc-cccc-4ccc-cccc-cccccccccccc',
        );
        expect(
            queries.some((query) =>
                query.text.includes('INSERT INTO "agent_ext"."messages"'),
            ),
        ).toBe(true);
    });

    it('refuses messages in foreign threads', async () => {
        const { db, queued } = setup();
        queued.push([threadRow()]);
        const store = createThreadStore(db);
        await expect(
            store.createMessage(
                {
                    content: 'Hello',
                    role: 'user',
                    threadUuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
                },
                {
                    isOrgAdmin: false,
                    organizationUuid: ORG,
                    requesterUuid: OTHER,
                },
            ),
        ).rejects.toBeInstanceOf(ThreadStoreError);
    });
});
