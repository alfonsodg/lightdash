import {
    FeatureFlags,
    ForbiddenError,
    NotFoundError,
    ParameterError,
    type Account,
    type SessionUser,
} from '@lightdash/common';
import express, { type Request, type Response, type Router } from 'express';
import {
    allowApiKeyAuthentication,
    isAuthenticated,
} from '../controllers/authentication';
import type { AgentBiService } from '../services/AgentBiService';

const getService = (req: Request): AgentBiService =>
    req.services.getAgentBiService() as AgentBiService;

const getAccount = (req: Request): Account | SessionUser => {
    const { account } = req as unknown as { account?: unknown };
    if (account !== undefined && account !== null) {
        return account as Account;
    }
    if (req.user === undefined) {
        throw new ForbiddenError();
    }
    return req.user as unknown as SessionUser;
};

const toHttpError = (error: unknown): Error => {
    if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof (error as { code: unknown }).code === 'string'
    ) {
        const { code } = error as { code: string };
        const message =
            error instanceof Error ? error.message : 'Unknown error';
        if (code === 'NOT_FOUND') {
            return new NotFoundError(message);
        }
        if (code === 'FORBIDDEN') {
            return new ForbiddenError();
        }
        if (code === 'INVALID_INPUT') {
            return new ParameterError(message);
        }
    }
    if (error instanceof Error) {
        return error;
    }
    return new Error('Unknown error');
};

export const createSkillsExtRouter = (): Router => {
    const router = express.Router({ mergeParams: true });

    router.use(allowApiKeyAuthentication, isAuthenticated);
    router.use(async (req, _res, next) => {
        try {
            const { enabled } = await req.services.getFeatureFlagService().get({
                featureFlagId: FeatureFlags.AgentBi,
                user: req.user!,
            });
            if (!enabled) {
                throw new NotFoundError('Not found');
            }
            next();
        } catch (error) {
            next(error);
        }
    });

    const resolveProject = (req: Request): string => {
        const { projectUuid } = req.params as { projectUuid: string };
        return projectUuid;
    };

    router.get('/', async (req, res, next) => {
        try {
            const projectUuid = resolveProject(req);
            const service = getService(req);
            const account = getAccount(req);
            await service.requireSkillsViewer(account, projectUuid);
            const skills = await service
                .getSkillStore()
                .listSkills({ projectUuid });
            res.status(200).json({ results: skills, status: 'ok' });
        } catch (error) {
            next(toHttpError(error));
        }
    });

    router.post('/', async (req, res, next) => {
        try {
            const projectUuid = resolveProject(req);
            const { enabled, manifest, slug, version } = req.body as {
                enabled?: unknown;
                manifest?: unknown;
                slug?: unknown;
                version?: unknown;
            };
            if (typeof slug !== 'string' || slug.trim().length === 0) {
                throw new ParameterError('A non-empty slug is required.');
            }
            if (manifest === undefined) {
                throw new ParameterError('A manifest is required.');
            }
            if (
                version !== undefined &&
                (typeof version !== 'string' || version.length === 0)
            ) {
                throw new ParameterError('version must be a non-empty string.');
            }
            if (enabled !== undefined && typeof enabled !== 'boolean') {
                throw new ParameterError('enabled must be a boolean.');
            }
            const service = getService(req);
            const account = getAccount(req);
            await service.requireSkillsEditor(account, projectUuid);
            const skill = await service.getSkillStore().createSkill({
                enabled: typeof enabled === 'boolean' ? enabled : undefined,
                manifest,
                projectUuid,
                slug,
                version: typeof version === 'string' ? version : undefined,
            });
            res.status(200).json({ results: skill, status: 'ok' });
        } catch (error) {
            next(toHttpError(error));
        }
    });

    router.get('/:skillUuid', async (req, res, next) => {
        try {
            const projectUuid = resolveProject(req);
            const { skillUuid } = req.params as { skillUuid: string };
            const service = getService(req);
            const account = getAccount(req);
            await service.requireSkillsViewer(account, projectUuid);
            const skills = await service
                .getSkillStore()
                .listSkills({ projectUuid });
            const skill = skills.find(
                (candidate) => candidate.skillUuid === skillUuid,
            );
            if (skill === undefined) {
                throw new NotFoundError('Skill was not found.');
            }
            res.status(200).json({ results: skill, status: 'ok' });
        } catch (error) {
            next(toHttpError(error));
        }
    });

    router.patch('/:skillUuid', async (req, res, next) => {
        try {
            const projectUuid = resolveProject(req);
            const { skillUuid } = req.params as { skillUuid: string };
            const { enabled, manifest, version } = req.body as {
                enabled?: unknown;
                manifest?: unknown;
                version?: unknown;
            };
            if (
                manifest === undefined &&
                version === undefined &&
                enabled === undefined
            ) {
                throw new ParameterError('Nothing to update.');
            }
            if (
                version !== undefined &&
                (typeof version !== 'string' || version.length === 0)
            ) {
                throw new ParameterError('version must be a non-empty string.');
            }
            if (enabled !== undefined && typeof enabled !== 'boolean') {
                throw new ParameterError('enabled must be a boolean.');
            }
            const service = getService(req);
            const account = getAccount(req);
            await service.requireSkillsEditor(account, projectUuid);
            const skill = await service.getSkillStore().updateSkill({
                patch: {
                    enabled: typeof enabled === 'boolean' ? enabled : undefined,
                    manifest,
                    version: typeof version === 'string' ? version : undefined,
                },
                projectUuid,
                skillUuid,
            });
            res.status(200).json({ results: skill, status: 'ok' });
        } catch (error) {
            next(toHttpError(error));
        }
    });

    router.delete('/:skillUuid', async (req, res, next) => {
        try {
            const projectUuid = resolveProject(req);
            const { skillUuid } = req.params as { skillUuid: string };
            const service = getService(req);
            const account = getAccount(req);
            await service.requireSkillsEditor(account, projectUuid);
            const store = service.getSkillStore();
            await store.deleteSkill({ projectUuid, skillUuid });
            res.status(200).json({ results: { skillUuid }, status: 'ok' });
        } catch (error) {
            next(toHttpError(error));
        }
    });

    return router;
};
