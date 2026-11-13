import { AuthorizationError, ForbiddenError } from '@lightdash/common';
// Slice 3 (TDD red): threads HTTP API on /api/ext/v1/projects/:projectUuid/threads.
// Live loopback through real HTTP; fake AgentBiService (no database, no LLM).
import express, { type ErrorRequestHandler } from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { buildAccount, defaultSessionUser } from '../auth/account/account.mock';
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
    account?: unknown;
    dashboardService?: Record<string, unknown>;
    projectService?: Record<string, unknown>;
    service?: Record<string, unknown>;
    user?: typeof defaultSessionUser | null;
}) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (options?.user !== undefined && options?.user !== null) {
            req.user = options.user;
        }
        if (options?.account !== undefined) {
            (req as unknown as { account: unknown }).account = options.account;
        }
        req.services = {
            getAgentBiService: () => options?.service ?? {},
            getDashboardService: () => options?.dashboardService ?? {},
            getProjectService: () => options?.projectService ?? {},
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
    it('builds catalog visibility from the caller-authorized explore fields', async () => {
        const denied = new AuthorizationError(
            "You don't have authorization to access this explore",
        );
        const getExplore = vi.fn(
            async (_account: unknown, _project: string, name: string) => {
                if (name === 'private') throw denied;
                return {
                    tables: {
                        orders: {
                            dimensions: {
                                hidden_field: { hidden: true },
                                status: { hidden: false },
                            },
                            metrics: { revenue: { hidden: false } },
                            name: 'orders',
                        },
                    },
                };
            },
        );
        const getCatalogExploreNames = vi.fn(async () => ['orders', 'private']);
        const runThreadTurn = vi.fn(
            async (input: {
                getCatalogVisibility: () => Promise<{
                    allowedExplores: Set<string>;
                    allowedFieldsByExplore: Map<string, Set<string>>;
                }>;
                onEvent: (event: { type: 'done' }) => void;
            }) => {
                const visibility = await input.getCatalogVisibility();
                expect(visibility.allowedExplores).toEqual(new Set(['orders']));
                expect(visibility.allowedFieldsByExplore.get('orders')).toEqual(
                    new Set(['orders.status', 'orders.revenue']),
                );
                input.onEvent({ type: 'done' });
            },
        );
        const server = await startApp({
            account: buildAccount(),
            projectService: { getExplore },
            service: {
                getCatalogExploreNames,
                isProjectAuditor: () => false,
                requireProjectViewer: async () => ({
                    organizationUuid: '11111111-1111-4111-8111-111111111111',
                }),
                runThreadTurn,
            },
            user: { ...godMode() },
        });
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/threads/${THREAD_UUID}/messages/stream`,
                {
                    body: JSON.stringify({ userText: 'Find order status' }),
                    headers: { 'content-type': 'application/json' },
                    method: 'POST',
                },
            );
            const responseText = await response.text();
            expect(response.status).toBe(200);
            expect(responseText).not.toContain('event: error');
            expect(getExplore).toHaveBeenCalledTimes(2);
            expect(runThreadTurn).toHaveBeenCalledOnce();
        } finally {
            await stopApp(server);
        }
    });

    it('authorizes a pinned dashboard before forwarding the live context', async () => {
        const getByIdOrSlug = vi.fn(async () => ({
            projectUuid: PROJECT_UUID,
            slug: 'revenue',
        }));
        const runThreadTurn = vi.fn(
            async (input: { onEvent: (event: { type: 'done' }) => void }) =>
                input.onEvent({ type: 'done' }),
        );
        const server = await startApp({
            dashboardService: { getByIdOrSlug },
            service: {
                isProjectAuditor: () => false,
                requireProjectViewer: async () => ({
                    organizationUuid: '11111111-1111-4111-8111-111111111111',
                }),
                runThreadTurn,
            },
            user: { ...godMode() },
        });
        const pinnedContext = { kind: 'dashboard', slug: 'revenue' };
        const runtimeOverrides = { parameters: { currency: 'EUR' } };
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/threads/${THREAD_UUID}/messages/stream`,
                {
                    body: JSON.stringify({
                        pinnedContext,
                        runtimeOverrides,
                        userText: 'What changed?',
                    }),
                    headers: {
                        'content-type': 'application/json',
                        cookie: 'session=test-session',
                    },
                    method: 'POST',
                },
            );
            expect(response.status).toBe(200);
            await response.text();
            expect(getByIdOrSlug).toHaveBeenCalledWith(
                expect.objectContaining({ userUuid: godMode().userUuid }),
                'revenue',
                { projectUuid: PROJECT_UUID },
            );
            expect(runThreadTurn).toHaveBeenCalledWith(
                expect.objectContaining({
                    headers: { Cookie: 'session=test-session' },
                    pinnedContext,
                    runtimeOverrides,
                }),
            );
        } finally {
            await stopApp(server);
        }
    });

    it('does not start a turn when pinned dashboard access is denied', async () => {
        const forbidden = new Error('Forbidden');
        (forbidden as { statusCode?: number }).statusCode = 403;
        const runThreadTurn = vi.fn(
            async (input: { onEvent: (event: { type: 'done' }) => void }) =>
                input.onEvent({ type: 'done' }),
        );
        const server = await startApp({
            dashboardService: {
                getByIdOrSlug: async () => {
                    throw forbidden;
                },
            },
            service: {
                isProjectAuditor: () => false,
                requireProjectViewer: async () => ({
                    organizationUuid: '11111111-1111-4111-8111-111111111111',
                }),
                runThreadTurn,
            },
            user: { ...godMode() },
        });
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/threads/${THREAD_UUID}/messages/stream`,
                {
                    body: JSON.stringify({
                        pinnedContext: { kind: 'dashboard', slug: 'revenue' },
                        userText: 'What changed?',
                    }),
                    headers: { 'content-type': 'application/json' },
                    method: 'POST',
                },
            );
            expect(response.status).toBe(403);
            expect(runThreadTurn).not.toHaveBeenCalled();
        } finally {
            await stopApp(server);
        }
    });

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

    it('denies cross-user thread reads, messages, and approvals with 403', async () => {
        const { ThreadStoreError } = await import('@lightdash/agent-bi');
        const denyOwnership = async () => {
            throw new ThreadStoreError(
                'FORBIDDEN',
                'You do not have access to this thread.',
            );
        };
        const server = await startApp({
            service: {
                getThreadStore: () => ({
                    getThread: denyOwnership,
                    listMessages: denyOwnership,
                }),
                resolveThreadApproval: denyOwnership,
                isProjectAuditor: () => false,
                requireProjectViewer: async () => ({
                    organizationUuid: '11111111-1111-4111-8111-111111111111',
                }),
            },
            user: { ...godMode() },
        });
        try {
            const threadRes = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/threads/${THREAD_UUID}`,
            );
            expect(threadRes.status).toBe(403);

            const messagesRes = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/threads/${THREAD_UUID}/messages`,
            );
            expect(messagesRes.status).toBe(403);

            const approvalRes = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/threads/${THREAD_UUID}/approvals/33333333-3333-4333-8333-333333333333`,
                {
                    body: JSON.stringify({ decision: 'approved' }),
                    headers: { 'content-type': 'application/json' },
                    method: 'POST',
                },
            );
            expect(approvalRes.status).toBe(403);
        } finally {
            await stopApp(server);
        }
    });
});
