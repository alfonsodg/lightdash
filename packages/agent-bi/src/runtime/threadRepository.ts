// User-owned conversation threads and messages over agent_ext.
// Every read and write checks ownership: the owner or an org admin auditor.

export interface ThreadQueryClient {
    query(
        text: string,
        params?: unknown[],
    ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type ThreadRole = 'assistant' | 'system' | 'tool' | 'user';

export interface ThreadRecord {
    createdAt: string;
    createdBy: string | null;
    organizationUuid: string;
    projectUuid: string | null;
    threadUuid: string;
    title: string;
    updatedAt: string;
}

export interface MessageRecord {
    content: string;
    createdAt: string;
    messageUuid: string;
    role: ThreadRole;
    threadUuid: string;
}

export interface ThreadAccess {
    isOrgAdmin: boolean;
    organizationUuid: string;
    requesterUuid: string;
}

export type ThreadStoreErrorCode = 'FORBIDDEN' | 'INVALID_INPUT' | 'NOT_FOUND';

export class ThreadStoreError extends Error {
    readonly code: ThreadStoreErrorCode;

    constructor(code: ThreadStoreErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = 'ThreadStoreError';
    }
}

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const assertUuid = (name: string, value: string): void => {
    if (!UUID_PATTERN.test(value)) {
        throw new ThreadStoreError(
            'INVALID_INPUT',
            `${name} must be a valid UUID.`,
        );
    }
};

const toISOString = (value: unknown): string => {
    if (value instanceof Date) {
        return value.toISOString();
    }
    return String(value ?? '');
};

const toThreadRecord = (row: Record<string, unknown>): ThreadRecord => ({
    createdAt: toISOString(row.created_at),
    createdBy: typeof row.created_by === 'string' ? row.created_by : null,
    organizationUuid: String(row.organization_uuid ?? ''),
    projectUuid: typeof row.project_uuid === 'string' ? row.project_uuid : null,
    threadUuid: String(row.thread_uuid ?? ''),
    title: typeof row.title === 'string' ? row.title : '',
    updatedAt: toISOString(row.updated_at),
});

const toMessageRecord = (row: Record<string, unknown>): MessageRecord => ({
    content: typeof row.content === 'string' ? row.content : '',
    createdAt: toISOString(row.created_at),
    messageUuid: String(row.message_uuid ?? ''),
    role: row.role as ThreadRole,
    threadUuid: String(row.thread_uuid ?? ''),
});

export const isThreadAccessible = (
    thread: Pick<ThreadRecord, 'createdBy'>,
    access: Pick<ThreadAccess, 'isOrgAdmin' | 'requesterUuid'>,
): boolean => {
    if (typeof thread.createdBy !== 'string' || thread.createdBy === '') {
        return false;
    }
    return (
        access.isOrgAdmin === true || thread.createdBy === access.requesterUuid
    );
};

const THREAD_COLUMNS =
    'thread_uuid, organization_uuid, project_uuid, created_by, title, created_at, updated_at';

const MESSAGE_COLUMNS = 'message_uuid, thread_uuid, role, content, created_at';

const THREAD_ROLES: readonly string[] = ['assistant', 'system', 'tool', 'user'];

export const createThreadStore = (db: ThreadQueryClient) => {
    const getThread = async (
        threadUuid: string,
        access: ThreadAccess,
    ): Promise<ThreadRecord | null> => {
        assertUuid('threadUuid', threadUuid);
        const { rows } = await db.query(
            `SELECT ${THREAD_COLUMNS} FROM "agent_ext"."threads" WHERE thread_uuid = $1 AND organization_uuid = $2`,
            [threadUuid, access.organizationUuid],
        );
        const row = rows[0];
        if (row === undefined) {
            return null;
        }
        const thread = toThreadRecord(row);
        if (
            !isThreadAccessible(thread, {
                isOrgAdmin: access.isOrgAdmin,
                requesterUuid: access.requesterUuid,
            })
        ) {
            throw new ThreadStoreError(
                'FORBIDDEN',
                'This thread is not accessible.',
            );
        }
        return thread;
    };

    const requireThread = async (
        threadUuid: string,
        access: ThreadAccess,
    ): Promise<ThreadRecord> => {
        const thread = await getThread(threadUuid, access);
        if (thread === null) {
            throw new ThreadStoreError('NOT_FOUND', 'Thread was not found.');
        }
        return thread;
    };

    return {
        createMessage: async (
            input: {
                content: string;
                role: ThreadRole;
                threadUuid: string;
            },
            access: ThreadAccess,
        ): Promise<MessageRecord> => {
            if (!THREAD_ROLES.includes(input.role)) {
                throw new ThreadStoreError(
                    'INVALID_INPUT',
                    'Message role is not recognized.',
                );
            }
            await requireThread(input.threadUuid, access);
            const { rows } = await db.query(
                `INSERT INTO "agent_ext"."messages" (thread_uuid, role, content) VALUES ($1, $2, $3) RETURNING ${MESSAGE_COLUMNS}`,
                [input.threadUuid, input.role, input.content],
            );
            const row = rows[0];
            if (row === undefined) {
                throw new ThreadStoreError(
                    'NOT_FOUND',
                    'Message was not created.',
                );
            }
            return toMessageRecord(row);
        },
        createThread: async (input: {
            createdBy: string;
            organizationUuid: string;
            projectUuid: string;
            title: string;
        }): Promise<ThreadRecord> => {
            assertUuid('organizationUuid', input.organizationUuid);
            assertUuid('projectUuid', input.projectUuid);
            assertUuid('createdBy', input.createdBy);
            const { rows } = await db.query(
                `INSERT INTO "agent_ext"."threads" (organization_uuid, project_uuid, created_by, title) VALUES ($1, $2, $3, $4) RETURNING ${THREAD_COLUMNS}`,
                [
                    input.organizationUuid,
                    input.projectUuid,
                    input.createdBy,
                    input.title,
                ],
            );
            const row = rows[0];
            if (row === undefined) {
                throw new ThreadStoreError(
                    'NOT_FOUND',
                    'Thread was not created.',
                );
            }
            return toThreadRecord(row);
        },
        getThread,
        getMessage: async (
            messageUuid: string,
            access: ThreadAccess,
        ): Promise<MessageRecord | null> => {
            assertUuid('messageUuid', messageUuid);
            const { rows } = await db.query(
                `SELECT ${MESSAGE_COLUMNS} FROM "agent_ext"."messages" WHERE message_uuid = $1`,
                [messageUuid],
            );
            const row = rows[0];
            if (row === undefined) {
                return null;
            }
            const message = toMessageRecord(row);
            await requireThread(message.threadUuid, access);
            return message;
        },
        listMessages: async (
            threadUuid: string,
            access: ThreadAccess,
        ): Promise<MessageRecord[]> => {
            await requireThread(threadUuid, access);
            const { rows } = await db.query(
                `SELECT ${MESSAGE_COLUMNS} FROM "agent_ext"."messages" WHERE thread_uuid = $1 ORDER BY created_at ASC`,
                [threadUuid],
            );
            return rows.map(toMessageRecord);
        },
        listThreads: async (
            access: ThreadAccess & { projectUuid: string },
        ): Promise<ThreadRecord[]> => {
            assertUuid('projectUuid', access.projectUuid);
            const params: unknown[] = [
                access.organizationUuid,
                access.projectUuid,
            ];
            const ownerFilter = access.isOrgAdmin ? '' : ' AND created_by = $3';
            if (!access.isOrgAdmin) {
                params.push(access.requesterUuid);
            }
            const { rows } = await db.query(
                `SELECT ${THREAD_COLUMNS} FROM "agent_ext"."threads" WHERE organization_uuid = $1 AND project_uuid = $2${ownerFilter} ORDER BY updated_at DESC`,
                params,
            );
            return rows.map(toThreadRecord);
        },
        updateMessageContent: async (
            messageUuid: string,
            content: string,
            access: ThreadAccess,
        ): Promise<MessageRecord> => {
            assertUuid('messageUuid', messageUuid);
            const lookup = await db.query(
                'SELECT thread_uuid FROM "agent_ext"."messages" WHERE message_uuid = $1',
                [messageUuid],
            );
            const owner = lookup.rows[0];
            if (owner === undefined || typeof owner.thread_uuid !== 'string') {
                throw new ThreadStoreError(
                    'NOT_FOUND',
                    'Message was not found.',
                );
            }
            await requireThread(owner.thread_uuid, access);
            const { rows } = await db.query(
                `UPDATE "agent_ext"."messages" SET content = $1 WHERE message_uuid = $2 RETURNING ${MESSAGE_COLUMNS}`,
                [content, messageUuid],
            );
            const row = rows[0];
            if (row === undefined) {
                throw new ThreadStoreError(
                    'NOT_FOUND',
                    'Message was not found.',
                );
            }
            return toMessageRecord(row);
        },
    };
};

export type ThreadStore = ReturnType<typeof createThreadStore>;
