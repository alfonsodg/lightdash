import {
    createAgentBiMcpServer,
    type McpServerDeps,
} from '@lightdash/agent-bi';
import { FeatureFlags, NotFoundError } from '@lightdash/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Router } from 'express';
import { oauthApiResource } from '../auth/oauthScopes/oauthResources';
import {
    allowApiKeyAuthentication,
    isAuthenticated,
} from '../controllers/authentication';
import { resolvePreflightPrincipal } from './agentBiPreflight';

export const createMcpExtRouter = ({
    createMcpDeps,
}: {
    createMcpDeps: (req: Request) => McpServerDeps;
}): Router => {
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

    const handleMcp = async (
        req: Request,
        res: express.Response,
        next: express.NextFunction,
    ): Promise<void> => {
        try {
            const principal = resolvePreflightPrincipal(req);
            const server = createAgentBiMcpServer({
                deps: createMcpDeps(req),
                principal,
            });
            const transport = new StreamableHTTPServerTransport({
                enableJsonResponse: true,
                sessionIdGenerator: undefined,
            });
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            next(error);
        }
    };

    router.post('/', handleMcp);
    router.get('/', handleMcp);
    router.delete('/', handleMcp);

    router.use(
        (
            error: unknown,
            req: Request,
            res: express.Response,
            next: express.NextFunction,
        ): void => {
            const status =
                typeof error === 'object' &&
                error !== null &&
                'statusCode' in error &&
                typeof error.statusCode === 'number'
                    ? error.statusCode
                    : 500;
            if (status !== 401) {
                next(error);
                return;
            }
            const siteUrl = oauthApiResource(
                req.services.getOauthService().getSiteUrl(),
            );
            res.set(
                'WWW-Authenticate',
                `Bearer resource_metadata="${siteUrl}/api/v1/oauth/.well-known/oauth-protected-resource"`,
            );
            res.status(401).json({ error: 'invalid_token' });
        },
    );

    return router;
};
