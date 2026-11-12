// Slice 3 (TDD): skills HTTP API on /api/ext/v1/projects/:projectUuid/skills.
// Live loopback through real HTTP; fake AgentBiService (no database, no LLM).
import express, { type ErrorRequestHandler } from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { defaultSessionUser } from '../auth/account/account.mock';
import { createSkillsExtRouter } from './skillsExtRouter';

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
const SKILL_UUID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

const skillRow = () => ({
    createdAt: '2026-01-02T03:04:05.000Z',
    enabled: true,
    manifest: { description: 'Test skill' },
    projectUuid: PROJECT_UUID,
    skillUuid: SKILL_UUID,
    slug: 'test-skill',
    updatedAt: '2026-01-02T03:04:05.000Z',
    version: '1',
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
        '/api/ext/v1/projects/:projectUuid/skills',
        createSkillsExtRouter(),
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

const viewerService = (store: Record<string, unknown>) => ({
    getSkillStore: () => store,
    requireSkillsEditor: async () => ({
        organizationUuid: '11111111-1111-4111-8111-111111111111',
    }),
    requireSkillsViewer: async () => ({
        organizationUuid: '11111111-1111-4111-8111-111111111111',
    }),
});

describe('skillsExtRouter auth contract', () => {
    it('rejects unauthenticated requests with 401', async () => {
        const server = await startApp();
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/skills`,
            );
            expect(response.status).toBe(401);
        } finally {
            await stopApp(server);
        }
    });

    it('maps forbidden access to 403 without leaking brand copy', async () => {
        const forbidden = new Error('Forbidden');
        (forbidden as { statusCode?: number }).statusCode = 403;
        const server = await startApp({
            service: {
                requireSkillsViewer: async () => {
                    throw forbidden;
                },
            },
            user: { ...godMode() },
        });
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/skills`,
            );
            expect(response.status).toBe(403);
            const body = (await response.json()) as { message: string };
            expect(body.message.toLowerCase()).not.toContain('lightdash');
        } finally {
            await stopApp(server);
        }
    });
});

describe('skillsExtRouter skills', () => {
    it('lists skills for an authorized viewer', async () => {
        const listSkills = vi.fn(async () => [skillRow()]);
        const server = await startApp({
            service: viewerService({ listSkills }),
            user: { ...godMode() },
        });
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/skills`,
            );
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
                results: Array<{ skillUuid: string }>;
                status: string;
            };
            expect(body.status).toBe('ok');
            expect(body.results.map((skill) => skill.skillUuid)).toEqual([
                SKILL_UUID,
            ]);
            expect(listSkills).toHaveBeenCalledOnce();
        } finally {
            await stopApp(server);
        }
    });

    it('creates a skill and returns it', async () => {
        const created = skillRow();
        const createSkill = vi.fn(async () => created);
        const server = await startApp({
            service: viewerService({ createSkill }),
            user: { ...godMode() },
        });
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/skills`,
                {
                    body: JSON.stringify({
                        manifest: { description: 'Test skill' },
                        slug: 'test-skill',
                    }),
                    headers: { 'content-type': 'application/json' },
                    method: 'POST',
                },
            );
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
                results: { skillUuid: string };
                status: string;
            };
            expect(body.status).toBe('ok');
            expect(body.results.skillUuid).toBe(SKILL_UUID);
            expect(createSkill).toHaveBeenCalledOnce();
        } finally {
            await stopApp(server);
        }
    });

    it('rejects creation without a slug with 400', async () => {
        const createSkill = vi.fn();
        const server = await startApp({
            service: viewerService({ createSkill }),
            user: { ...godMode() },
        });
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/skills`,
                {
                    body: JSON.stringify({
                        manifest: { description: 'Test skill' },
                    }),
                    headers: { 'content-type': 'application/json' },
                    method: 'POST',
                },
            );
            expect(response.status).toBe(400);
            expect(createSkill).not.toHaveBeenCalled();
        } finally {
            await stopApp(server);
        }
    });

    it('returns one skill by uuid and 404 for unknown uuid', async () => {
        const listSkills = vi.fn(async () => [skillRow()]);
        const server = await startApp({
            service: viewerService({ listSkills }),
            user: { ...godMode() },
        });
        try {
            const found = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/skills/${SKILL_UUID}`,
            );
            expect(found.status).toBe(200);
            const missing = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/skills/33333333-3333-4333-8333-333333333333`,
            );
            expect(missing.status).toBe(404);
        } finally {
            await stopApp(server);
        }
    });

    it('updates a skill and rejects empty patches with 400', async () => {
        const updated = { ...skillRow(), version: '2' };
        const updateSkill = vi.fn(async () => updated);
        const server = await startApp({
            service: viewerService({ updateSkill }),
            user: { ...godMode() },
        });
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/skills/${SKILL_UUID}`,
                {
                    body: JSON.stringify({ version: '2' }),
                    headers: { 'content-type': 'application/json' },
                    method: 'PATCH',
                },
            );
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
                results: { version: string };
                status: string;
            };
            expect(body.results.version).toBe('2');
            const empty = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/skills/${SKILL_UUID}`,
                {
                    body: JSON.stringify({}),
                    headers: { 'content-type': 'application/json' },
                    method: 'PATCH',
                },
            );
            expect(empty.status).toBe(400);
            expect(updateSkill).toHaveBeenCalledOnce();
        } finally {
            await stopApp(server);
        }
    });

    it('deletes a skill and maps unknown uuid to 404', async () => {
        const notFound = new Error('Skill was not found.');
        (notFound as { code?: string }).code = 'NOT_FOUND';
        const deleteSkill = vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(notFound);
        const server = await startApp({
            service: viewerService({ deleteSkill }),
            user: { ...godMode() },
        });
        try {
            const response = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/skills/${SKILL_UUID}`,
                { method: 'DELETE' },
            );
            expect(response.status).toBe(200);
            const missing = await fetch(
                `${baseOf(server)}/api/ext/v1/projects/${PROJECT_UUID}/skills/33333333-3333-4333-8333-333333333333`,
                { method: 'DELETE' },
            );
            expect(missing.status).toBe(404);
        } finally {
            await stopApp(server);
        }
    });
});
