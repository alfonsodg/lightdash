import { type RouteObject } from 'react-router';
import PrivateRoute from '../../components/PrivateRoute';
import { loadLazyRouteDefault } from '../../features/chunkErrorHandler';

export const AgentBiExtRoutes: RouteObject[] = [
    {
        handle: { hideAILauncher: true },
        path: '/projects/:projectUuid/agent-bi',
        lazy: async () => {
            const AgentBiWorkspacePage = await loadLazyRouteDefault(
                './pages/AgentBiWorkspacePage',
                () => import('./pages/AgentBiWorkspacePage'),
            );
            return {
                Component: () => (
                    <PrivateRoute>
                        <AgentBiWorkspacePage />
                    </PrivateRoute>
                ),
            };
        },
    },
];
