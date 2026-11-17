import { FeatureFlags, NotFoundError } from '@lightdash/common';
import express, { type Router } from 'express';
import {
    allowApiKeyAuthentication,
    isAuthenticated,
} from '../controllers/authentication';
import {
    evaluatePreflightCapabilities,
    listPreflightCapabilityNames,
    resolvePreflightPrincipal,
} from './agentBiPreflight';
import { createMcpExtRouter } from './mcpExtRouter';
import { createSkillsExtRouter } from './skillsExtRouter';
import { createThreadsExtRouter } from './threadsExtRouter';

export const agentBiRouter: Router = express.Router({ mergeParams: true });

agentBiRouter.use(
    '/mcp',
    createMcpExtRouter({
        createMcpDeps: (req) =>
            req.services.getAgentBiService().buildMcpServerDeps(req),
    }),
);

agentBiRouter.use('/projects/:projectUuid/threads', createThreadsExtRouter());

agentBiRouter.use('/projects/:projectUuid/skills', createSkillsExtRouter());

agentBiRouter.get(
    '/projects/:projectUuid/schemas',
    allowApiKeyAuthentication,
    isAuthenticated,
    async (req, res, next) => {
        try {
            const { enabled } = await req.services.getFeatureFlagService().get({
                user: req.user!,
                featureFlagId: FeatureFlags.AgentBi,
            });
            if (!enabled) {
                throw new NotFoundError('Not found');
            }
            const { projectUuid } = req.params as { projectUuid: string };
            await req.services
                .getAgentBiService()
                .requireProjectViewer(req.account!, projectUuid);

            const schemas = new Set<string>();
            try {
                const sqlResult = await req.services
                    .getProjectService()
                    .runSqlQuery(
                        req.user!,
                        projectUuid,
                        "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND schema_name NOT LIKE 'pg_temp_%' ORDER BY schema_name",
                        {
                            kind: 'connection',
                            warehouseConnectionUuid: null,
                        },
                    );
                for (const row of sqlResult.rows ?? []) {
                    const name =
                        typeof row.schema_name === 'string'
                            ? row.schema_name.trim()
                            : '';
                    if (name.length > 0) {
                        schemas.add(name);
                    }
                }
            } catch {
                // Fallback to catalog database/schema names if information_schema query fails.
            }

            if (schemas.size === 0) {
                const catalog = await req.services
                    .getProjectService()
                    .getCatalog(req.user!, projectUuid);
                for (const dbOrTable of Object.values(catalog)) {
                    for (const table of Object.values(
                        dbOrTable as Record<string, { schemaName?: unknown }>,
                    )) {
                        const schemaName = table?.schemaName;
                        if (
                            typeof schemaName === 'string' &&
                            schemaName.trim().length > 0
                        ) {
                            schemas.add(schemaName.trim());
                        }
                    }
                }
            }

            res.json({
                status: 'ok',
                results: Array.from(schemas).sort(),
            });
        } catch (error) {
            next(error);
        }
    },
);

// Health gate for the isolated analytics-agent extension. Authentication
// runs first so unauthenticated callers get 401 before flag evaluation.
agentBiRouter.get(
    '/health',
    allowApiKeyAuthentication,
    isAuthenticated,
    async (req, res, next) => {
        try {
            const { enabled } = await req.services.getFeatureFlagService().get({
                user: req.user!,
                featureFlagId: FeatureFlags.AgentBi,
            });
            if (!enabled) {
                throw new NotFoundError('Not found');
            }
            res.json({ status: 'ok', results: { enabled: true } });
        } catch (error) {
            next(error);
        }
    },
);

// Preflight surface for the isolated analytics-agent extension. Auth runs
// first so unauthenticated callers get 401 before flag evaluation; the
// resolved principal and its effective capabilities are per user, and the
// response carries no tokens, secrets or ability internals.
agentBiRouter.get(
    '/preflight',
    allowApiKeyAuthentication,
    isAuthenticated,
    async (req, res, next) => {
        try {
            const { enabled } = await req.services.getFeatureFlagService().get({
                user: req.user!,
                featureFlagId: FeatureFlags.AgentBi,
            });
            if (!enabled) {
                throw new NotFoundError('Not found');
            }
            const principal = resolvePreflightPrincipal(req);
            res.json({
                status: 'ok',
                results: {
                    principal: {
                        userUuid: principal.userUuid,
                        organizationUuid: principal.organizationUuid,
                        authType: principal.authType,
                        userAttributesHash: principal.userAttributesHash,
                        cacheKey: principal.cacheKey,
                    },
                    capabilities: listPreflightCapabilityNames(principal),
                    verdicts: evaluatePreflightCapabilities(principal),
                },
            });
        } catch (error) {
            next(error);
        }
    },
);

export default agentBiRouter;
