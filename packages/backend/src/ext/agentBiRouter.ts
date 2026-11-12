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

export const agentBiRouter: Router = express.Router({ mergeParams: true });

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
