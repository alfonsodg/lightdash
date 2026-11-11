import { FeatureFlags, NotFoundError } from '@lightdash/common';
import express, { type Router } from 'express';
import {
    allowApiKeyAuthentication,
    isAuthenticated,
} from '../controllers/authentication';

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

export default agentBiRouter;
