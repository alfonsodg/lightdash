// Slice 3 (TDD red): threads HTTP API on /api/ext/v1/projects/:projectUuid/threads.
// Live loopback through real HTTP; fake AgentBiService (no database, no LLM).
import express, { type ErrorRequestHandler } from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { defaultSessionUser } from '../auth/account/account.mock';
import { createThreadsExtRouter } from './threadsExtRouter';

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
const THREAD_UUID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

const threadRow = () => ({
    createdAt: '2026-01-02T03:04:05.000Z',
    createdBy: '11111111-1111-4111-8111-111111111111',
    organizationUuid: '11111111-1111-4111-8111-111111111111',
    projectUuid: PROJECT_UUID,
    threadUuid: THREAD_UUID,
    title: 'Test thread',
    updatedAt: '2026-01-02T03:04:05.000Z',
});

const godMode = () => ({
    ...defaultSessionUser,
    userUuid: '11111111-1111-4111-8111-111111111111',
});

const startApp = (options?: {
    service?: Record<string, unknown>;
    user?: typeof defaultSessionUser | null;
}) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (options?.user !== undefined && options?.user !== null) {
            req.user = options.user;
        }
        req.services = {
            getAgentBiService: () => options?.service ?? {},
            getFeatureFlagService: () => ({
                get: async () => ({ enabled: true }),
            }),
        } as never;
        next();
    });
    app.use(
        '/api/ext/v1/projects/:projectUuid/threads',
        createThreadsExtRouter(),
    );
    const errors: ErrorRequestHandler = (error, _req, res, _next) => {
        res.status(error.statusCode ?? 500).json({
            error: error.name,
            message: error.message,
        });
    };
    app.use(errors);
    const server = app.listen(0, '127.0.0.1');
    return once(server, 'listening').then(() => server);
};

const stopApp = async (
    server: Awaited<ReturnType<typeof startApp>>,
): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
};

const baseOf = (server: Awaited<ReturnType<typeof startApp>>): string =>
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

describe('threadsExtRouter auth contract', () => {
    it('rejects unauthenticated requests with 401', async () => {
        const server = await startApp();
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/threads`,
            );
            expect(response.status).toBe(401);
        } finally {
            await stopApp(server);
        }
    });
});

describe('threadsExtRouter threads', () => {
    it('lists threads for an authorized user', async () => {
        const listThreads = vi.fn(async () => [threadRow()]);
        const server = await startApp({
            service: {
                getThreadStore: () => ({ listThreads }),
                isProjectAuditor: () => false,
                requireProjectViewer: async () => ({
                    organizationUuid: '11111111-1111-4111-8111-111111111111',
                }),
            },
            user: { ...godMode() },
        });
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/threads`,
            );
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
                results: Array<{ threadUuid: string }>;
                status: string;
            };
            expect(body.status).toBe('ok');
            expect(body.results.map((thread) => thread.threadUuid)).toEqual([
                THREAD_UUID,
            ]);
            expect(listThreads).toHaveBeenCalledOnce();
        } finally {
            await stopApp(server);
        }
    });

    it('creates a thread and returns it', async () => {
        const created = threadRow();
        const createThread = vi.fn(async () => created);
        const server = await startApp({
            service: {
                getThreadStore: () => ({ createThread }),
                isProjectAuditor: () => false,
                requireProjectViewer: async () => ({
                    organizationUuid: '11111111-1111-4111-8111-111111111111',
                }),
                requireThreadCreator: async () => ({
                    organizationUuid: '11111111-1111-4111-8111-111111111111',
                }),
            },
            user: { ...godMode() },
        });
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/threads`,
                {
                    body: JSON.stringify({ title: 'Hello' }),
                    headers: { 'content-type': 'application/json' },
                    method: 'POST',
                },
            );
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
                results: { threadUuid: string };
                status: string;
            };
            expect(body.status).toBe('ok');
            expect(body.results.threadUuid).toBe(THREAD_UUID);
            expect(createThread).toHaveBeenCalledOnce();
        } finally {
            await stopApp(server);
        }
    });

    it('maps forbidden access to 403 without leaking brand copy', async () => {
        const forbidden = new Error('Forbidden');
        (forbidden as { statusCode?: number }).statusCode = 403;
        const server = await startApp({
            service: {
                requireProjectViewer: async () => {
                    throw forbidden;
                },
            },
            user: { ...godMode() },
        });
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/threads`,
            );
            expect(response.status).toBe(403);
            const body = (await response.json()) as { message: string };
            expect(body.message.toLowerCase()).not.toContain('lightdash');
        } finally {
            await stopApp(server);
        }
    });
});
