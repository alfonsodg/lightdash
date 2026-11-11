import { FeatureFlags } from '@lightdash/common';
import express, { type ErrorRequestHandler } from 'express';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { defaultSessionUser } from '../auth/account/account.mock';
import { agentBiRouter } from './agentBiRouter';

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

const startApp = async (options: {
    user: typeof defaultSessionUser | undefined;
    flagEnabled: boolean;
    flagGet: ReturnType<typeof vi.fn>;
}) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (options.user) {
            req.user = options.user;
        }
        req.services = {
            getFeatureFlagService: () => ({ get: options.flagGet }),
        } as never;
        next();
    });
    app.use('/api/ext/v1', agentBiRouter);
    const errors: ErrorRequestHandler = (error, _req, res, _next) => {
        res.status(error.statusCode ?? 500).json({
            error: error.name,
            message: error.message,
        });
    };
    app.use(errors);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
};

const stopApp = async (server: Awaited<ReturnType<typeof startApp>>) => {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
};

describe('agentBiRouter health gate', () => {
    test('rejects unauthenticated requests before flag evaluation', async () => {
        const flagGet = vi.fn(async () => ({ enabled: true }));
        const server = await startApp({
            user: undefined,
            flagEnabled: true,
            flagGet,
        });
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const response = await fetch(`${base}/api/ext/v1/health`);
            expect(response.status).toBe(401);
            expect(flagGet).not.toHaveBeenCalled();
        } finally {
            await stopApp(server);
        }
    });

    test('returns 404 when the flag is off for the actor', async () => {
        const flagGet = vi.fn(async () => ({ enabled: false }));
        const server = await startApp({
            user: defaultSessionUser,
            flagEnabled: false,
            flagGet,
        });
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const response = await fetch(`${base}/api/ext/v1/health`);
            expect(response.status).toBe(404);
            expect(flagGet).toHaveBeenCalledWith({
                user: defaultSessionUser,
                featureFlagId: FeatureFlags.AgentBi,
            });
        } finally {
            await stopApp(server);
        }
    });

    test('returns ok payload when the flag is on for the actor', async () => {
        const flagGet = vi.fn(async () => ({ enabled: true }));
        const server = await startApp({
            user: defaultSessionUser,
            flagEnabled: true,
            flagGet,
        });
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const response = await fetch(`${base}/api/ext/v1/health`);
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                status: 'ok',
                results: { enabled: true },
            });
            expect(flagGet).toHaveBeenCalledWith({
                user: defaultSessionUser,
                featureFlagId: FeatureFlags.AgentBi,
            });
        } finally {
            await stopApp(server);
        }
    });

    test('does not depend on the extension package', () => {
        const source = readFileSync(
            path.join(__dirname, 'agentBiRouter.ts'),
            'utf8',
        );
        expect(source).not.toContain('@lightdash/agent-bi');
    });
});
