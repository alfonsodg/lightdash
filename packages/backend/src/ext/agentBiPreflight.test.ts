import {
    evaluatePreflightCapabilities,
    listPreflightCapabilityNames,
    resolvePreflightPrincipal,
} from './agentBiPreflight';

// Models CASL semantics: `manage` on a subject implies every action there.
const canFor = (rules: Array<{ action: string; subject: string }>) => ({
    can: (action: string, subject: string) =>
        rules.some(
            (rule) =>
                rule.subject === subject &&
                (rule.action === action || rule.action === 'manage'),
        ),
});

const developerAbility = canFor([
    { action: 'view', subject: 'Project' },
    { action: 'manage', subject: 'Explore' },
    { action: 'manage', subject: 'SqlRunner' },
]);

const viewerAbility = canFor([{ action: 'view', subject: 'Project' }]);

const sessionRequest = (overrides: Record<string, unknown> = {}) =>
    ({
        account: undefined,
        user: {
            userUuid: 'user-1',
            organizationUuid: 'org-1',
            ability: developerAbility,
            ...overrides,
        },
    }) as never;

const accountRequest = (type: string, ability: unknown = developerAbility) =>
    ({
        account: {
            authentication: { type },
            organization: { organizationUuid: 'org-1' },
            user: { userUuid: 'user-1', type: 'registered', ability },
        },
        user: undefined,
    }) as never;

describe('resolvePreflightPrincipal', () => {
    test('rejects requests with no identity before any other evaluation', () => {
        const error = (() => {
            try {
                resolvePreflightPrincipal({} as never);
            } catch (thrown) {
                return thrown as Error & { statusCode?: number; code?: string };
            }
            throw new Error('expected resolvePreflightPrincipal to throw');
        })();
        expect(error.statusCode).toBe(401);
        expect(error.code).toBe('MISSING_CREDENTIALS');
    });

    test('derives a session principal from req.user alone', () => {
        const principal = resolvePreflightPrincipal(sessionRequest());
        expect(principal.userUuid).toBe('user-1');
        expect(principal.organizationUuid).toBe('org-1');
        expect(principal.authType).toBe('session');
        expect(principal.cacheKey).toContain('session:user-1:org-1:');
    });

    test('derives a pat principal from req.account', () => {
        const principal = resolvePreflightPrincipal(accountRequest('pat'));
        expect(principal.authType).toBe('pat');
        expect(principal.cacheKey.startsWith('pat:')).toBe(true);
    });

    test('derives an oauth principal from req.account', () => {
        const principal = resolvePreflightPrincipal(accountRequest('oauth'));
        expect(principal.authType).toBe('oauth');
    });

    test('refuses service-account credentials without revealing secrets', () => {
        const error = (() => {
            try {
                resolvePreflightPrincipal(accountRequest('service-account'));
            } catch (thrown) {
                return thrown as Error & { statusCode?: number; code?: string };
            }
            throw new Error('expected resolvePreflightPrincipal to throw');
        })();
        expect(error.statusCode).toBe(401);
        expect(error.code).toBe('UNSUPPORTED_AUTH_TYPE');
        expect(error.message).not.toContain('ldsvc_');
    });

    test('refuses jwt embed credentials', () => {
        const error = (() => {
            try {
                resolvePreflightPrincipal(accountRequest('jwt'));
            } catch (thrown) {
                return thrown as Error & { statusCode?: number; code?: string };
            }
            throw new Error('expected resolvePreflightPrincipal to throw');
        })();
        expect(error.statusCode).toBe(401);
        expect(error.code).toBe('UNSUPPORTED_AUTH_TYPE');
    });

    test('keeps cache keys isolated per user and per auth type', () => {
        const first = resolvePreflightPrincipal(sessionRequest());
        const otherUser = resolvePreflightPrincipal(
            sessionRequest({ userUuid: 'user-2' }),
        );
        const otherAuth = resolvePreflightPrincipal(accountRequest('pat'));
        expect(otherUser.cacheKey).not.toBe(first.cacheKey);
        expect(otherAuth.cacheKey).not.toBe(first.cacheKey);
    });
});

describe('evaluatePreflightCapabilities', () => {
    test('allows CASL-backed capabilities for a developer-like ability', () => {
        const principal = resolvePreflightPrincipal(sessionRequest());
        const verdicts = evaluatePreflightCapabilities(principal);
        expect(verdicts.discover.allowed).toBe(true);
        expect(verdicts.metric_query.allowed).toBe(true);
        expect(verdicts.compose_query.allowed).toBe(true);
    });

    test('keeps raw_sql disabled by default even with manage:SqlRunner', () => {
        const principal = resolvePreflightPrincipal(sessionRequest());
        const verdicts = evaluatePreflightCapabilities(principal);
        expect(verdicts.raw_sql.allowed).toBe(false);
        if (!verdicts.raw_sql.allowed) {
            expect(verdicts.raw_sql.reason).toBe('CAPABILITY_DISABLED');
        }
    });

    test('denies metric_query for a viewer-like ability', () => {
        const principal = resolvePreflightPrincipal(
            sessionRequest({ ability: viewerAbility }),
        );
        const verdicts = evaluatePreflightCapabilities(principal);
        expect(verdicts.discover.allowed).toBe(true);
        expect(verdicts.metric_query.allowed).toBe(false);
        if (!verdicts.metric_query.allowed) {
            expect(verdicts.metric_query.reason).toBe(
                'INSUFFICIENT_PERMISSIONS',
            );
        }
    });

    test('lists only the allowed capabilities for preflight responses', () => {
        const principal = resolvePreflightPrincipal(
            sessionRequest({ ability: viewerAbility }),
        );
        expect(listPreflightCapabilityNames(principal)).toEqual(['discover']);
    });

    test('keeps every message free of brand strings', () => {
        const principal = resolvePreflightPrincipal(
            sessionRequest({ ability: viewerAbility }),
        );
        const verdicts = evaluatePreflightCapabilities(principal);
        const messages = Object.values(verdicts).flatMap((verdict) =>
            verdict.allowed ? [] : [verdict.message],
        );
        expect(messages.length).toBeGreaterThan(0);
        for (const message of messages) {
            expect(message.toLowerCase()).not.toContain('lightdash');
        }
    });
});
