import type { OrchestratorEvent } from '@lightdash/agent-bi';
import {
    ConflictError,
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
import { resolvePreflightPrincipal } from './agentBiPreflight';

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
        if (code === 'ALREADY_DECIDED') {
            return new ConflictError(message);
        }
    }
    if (error instanceof Error) {
        return error;
    }
    return new Error('Unknown error');
};

const writeSseEvent = (res: Response, type: string, data: unknown): void => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
};

export const createThreadsExtRouter = (): Router => {
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

    const resolveAccess = async (req: Request, projectUuid: string) => {
        const service = getService(req);
        const account = getAccount(req);
        const { organizationUuid } = await service.requireProjectViewer(
            account,
            projectUuid,
        );
        const principal = resolvePreflightPrincipal(req);
        const isOrgAdmin = service.isProjectAuditor(
            account,
            organizationUuid,
            projectUuid,
        );
        return {
            access: {
                isOrgAdmin,
                organizationUuid,
                requesterUuid: principal.userUuid,
            },
            principal,
        };
    };

    router.get('/', async (req, res, next) => {
        try {
            const { projectUuid } = req.params as { projectUuid: string };
            const service = getService(req);
            const account = getAccount(req);
            const { organizationUuid } = await service.requireProjectViewer(
                account,
                projectUuid,
            );
            const store = service.getThreadStore();
            const threads = await store.listThreads({
                isOrgAdmin: service.isProjectAuditor(
                    account,
                    organizationUuid,
                    projectUuid,
                ),
                organizationUuid,
                projectUuid,
                requesterUuid: resolvePreflightPrincipal(req).userUuid,
            });
            res.status(200).json({ results: threads, status: 'ok' });
        } catch (error) {
            next(toHttpError(error));
        }
    });

    router.post('/', async (req, res, next) => {
        try {
            const { projectUuid } = req.params as { projectUuid: string };
            const { title } = req.body as { title?: unknown };
            const service = getService(req);
            const account = getAccount(req);
            const { organizationUuid } = await service.requireThreadCreator(
                account,
                projectUuid,
            );
            const principal = resolvePreflightPrincipal(req);
            const store = service.getThreadStore();
            const thread = await store.createThread({
                createdBy: principal.userUuid,
                organizationUuid,
                projectUuid,
                title: typeof title === 'string' ? title : '',
            });
            res.status(200).json({ results: thread, status: 'ok' });
        } catch (error) {
            next(toHttpError(error));
        }
    });

    router.get('/:threadUuid', async (req, res, next) => {
        try {
            const { projectUuid, threadUuid } = req.params as {
                projectUuid: string;
                threadUuid: string;
            };
            const { access } = await resolveAccess(req, projectUuid);
            const service = getService(req);
            const thread = await service
                .getThreadStore()
                .getThread(threadUuid, access);
            if (thread === null || thread.projectUuid !== projectUuid) {
                throw new NotFoundError('Thread was not found.');
            }
            res.status(200).json({ results: thread, status: 'ok' });
        } catch (error) {
            next(toHttpError(error));
        }
    });

    router.get('/:threadUuid/messages', async (req, res, next) => {
        try {
            const { projectUuid, threadUuid } = req.params as {
                projectUuid: string;
                threadUuid: string;
            };
            const { access } = await resolveAccess(req, projectUuid);
            const service = getService(req);
            const thread = await service
                .getThreadStore()
                .getThread(threadUuid, access);
            if (thread === null || thread.projectUuid !== projectUuid) {
                throw new NotFoundError('Thread was not found.');
            }
            const messages = await service
                .getThreadStore()
                .listMessages(threadUuid, access);
            res.status(200).json({ results: messages, status: 'ok' });
        } catch (error) {
            next(toHttpError(error));
        }
    });

    router.post('/:threadUuid/messages/stream', async (req, res, next) => {
        try {
            const { projectUuid, threadUuid } = req.params as {
                projectUuid: string;
                threadUuid: string;
            };
            const { userText, resumeApproved } = req.body as {
                resumeApproved?: {
                    approvalUuid: string;
                    input: unknown;
                    tool: string;
                };
                userText?: unknown;
            };
            if (
                userText !== undefined &&
                (typeof userText !== 'string' || userText.length === 0)
            ) {
                throw new ParameterError('A non-empty userText is required.');
            }
            const { access, principal } = await resolveAccess(req, projectUuid);
            const { userUuid } = principal;
            if (typeof userUuid !== 'string') {
                throw new ForbiddenError();
            }
            const service = getService(req);
            const headers: Record<string, string> = {};
            const { authorization } = req.headers;
            if (typeof authorization === 'string' && authorization.length > 0) {
                headers.Authorization = authorization;
            }
            res.writeHead(200, {
                Connection: 'keep-alive',
                'Content-Type': 'text/event-stream',
                'X-Accel-Buffering': 'no',
            });
            const onEvent = (event: OrchestratorEvent): void => {
                writeSseEvent(res, event.type, event);
                if (
                    event.type === 'done' ||
                    event.type === 'error' ||
                    event.type === 'approval_required'
                ) {
                    res.end();
                }
            };
            await service.runThreadTurn({
                access,
                headers,
                onEvent,
                principal: {
                    ...principal,
                    userUuid,
                },
                projectUuid,
                resumeApproved,
                threadUuid,
                userText:
                    typeof userText === 'string' && userText.length > 0
                        ? userText
                        : undefined,
            });
        } catch (error) {
            if (!res.headersSent) {
                next(toHttpError(error));
                return;
            }
            try {
                writeSseEvent(res, 'error', {
                    message:
                        error instanceof Error
                            ? error.message
                            : 'Unknown error',
                    type: 'error',
                });
                res.end();
            } catch {
                next(error);
            }
        }
    });

    router.post(
        '/:threadUuid/approvals/:approvalUuid',
        async (req, res, next) => {
            try {
                const { approvalUuid, projectUuid, threadUuid } =
                    req.params as {
                        approvalUuid: string;
                        projectUuid: string;
                        threadUuid: string;
                    };
                const { decision } = req.body as { decision?: unknown };
                if (decision !== 'approved' && decision !== 'rejected') {
                    throw new ParameterError(
                        'decision must be approved or rejected.',
                    );
                }
                const service = getService(req);
                const account = getAccount(req);
                const { organizationUuid } = await service.requireProjectViewer(
                    account,
                    projectUuid,
                );
                const principal = resolvePreflightPrincipal(req);
                const approval = await service.resolveThreadApproval(
                    account,
                    principal,
                    projectUuid,
                    threadUuid,
                    approvalUuid,
                    decision,
                );
                res.status(200).json({ results: approval, status: 'ok' });
            } catch (error) {
                next(toHttpError(error));
            }
        },
    );

    return router;
};
