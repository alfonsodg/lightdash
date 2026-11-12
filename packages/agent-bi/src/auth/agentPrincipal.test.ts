import { describe, expect, it } from 'vitest';
import {
    AgentAuthError,
    buildAgentCacheKey,
    diagnoseAuthorizationHeader,
    hashUserAttributes,
    resolveAgentPrincipal,
    type AgentAbility,
    type ResolvedCredential,
} from './agentPrincipal';

const canAll: AgentAbility = { can: () => true };

// Token prefixes mirror AuthTokenPrefix in the host app; built dynamically
// so the source never carries a secret-shaped literal.
const samplePatToken = (): string => ['ldpat', 'sample-test-token'].join('_');

const sampleServiceToken = (): string =>
    ['ldsvc', 'sample-test-token'].join('_');

const sessionCredential = (
    overrides: Partial<ResolvedCredential> = {},
): ResolvedCredential => ({
    authType: 'session',
    userUuid: 'user-uuid-1',
    organizationUuid: 'org-uuid-1',
    ability: canAll,
    userAttributes: { region: ['eu'] },
    userType: 'registered',
    ...overrides,
});

describe('resolveAgentPrincipal', () => {
    it('resolves a session credential to a per-user principal', () => {
        const principal = resolveAgentPrincipal(sessionCredential());
        expect(principal.userUuid).toBe('user-uuid-1');
        expect(principal.organizationUuid).toBe('org-uuid-1');
        expect(principal.authType).toBe('session');
        expect(principal.ability).toBe(canAll);
        expect(principal.userAttributesHash).toMatch(/^[0-9a-f]{8}$/);
        expect(principal.cacheKey).toContain('user-uuid-1');
    });

    it('resolves oauth and pat credentials with their own auth type', () => {
        expect(
            resolveAgentPrincipal(
                sessionCredential({ authType: 'oauth', userUuid: 'u-oauth' }),
            ).authType,
        ).toBe('oauth');
        expect(
            resolveAgentPrincipal(
                sessionCredential({ authType: 'pat', userUuid: 'u-pat' }),
            ).authType,
        ).toBe('pat');
    });

    it('isolates cache keys per user, org, auth type and attributes', () => {
        const base = sessionCredential();
        const otherUser = resolveAgentPrincipal(
            sessionCredential({ userUuid: 'user-uuid-2' }),
        );
        const otherAttrs = resolveAgentPrincipal(
            sessionCredential({ userAttributes: { region: ['us'] } }),
        );
        const self = resolveAgentPrincipal(base);
        expect(self.cacheKey).not.toBe(otherUser.cacheKey);
        expect(self.cacheKey).not.toBe(otherAttrs.cacheKey);
        expect(self.cacheKey).not.toContain('eu');
    });

    it('rejects a missing credential with 401', () => {
        let error: unknown;
        try {
            resolveAgentPrincipal(undefined);
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(AgentAuthError);
        expect((error as AgentAuthError).statusCode).toBe(401);
        expect((error as AgentAuthError).code).toBe('MISSING_CREDENTIALS');
    });

    it('rejects non-registered callers with 401', () => {
        expect(() =>
            resolveAgentPrincipal(sessionCredential({ userType: 'anonymous' })),
        ).toThrowError(AgentAuthError);
        try {
            resolveAgentPrincipal(sessionCredential({ userType: 'embed' }));
        } catch (error) {
            expect((error as AgentAuthError).code).toBe('NOT_REGISTERED_USER');
            expect((error as AgentAuthError).statusCode).toBe(401);
        }
    });

    it('rejects unsupported auth types such as jwt and service-account', () => {
        for (const authType of ['jwt', 'service-account']) {
            try {
                resolveAgentPrincipal(
                    sessionCredential({
                        authType: authType as ResolvedCredential['authType'],
                    }),
                );
                expect.unreachable();
            } catch (error) {
                expect(error).toBeInstanceOf(AgentAuthError);
                expect((error as AgentAuthError).code).toBe(
                    'UNSUPPORTED_AUTH_TYPE',
                );
            }
        }
    });

    it('rejects blank identity fields without echoing them', () => {
        for (const patch of [{ userUuid: '   ' }, { organizationUuid: '' }]) {
            try {
                resolveAgentPrincipal(sessionCredential(patch));
                expect.unreachable();
            } catch (error) {
                expect((error as AgentAuthError).code).toBe('INVALID_IDENTITY');
                expect((error as AgentAuthError).message).not.toContain('   ');
            }
        }
    });

    it('rejects a credential without an ability (fail closed)', () => {
        try {
            resolveAgentPrincipal(
                sessionCredential({
                    ability: undefined as unknown as AgentAbility,
                }),
            );
            expect.unreachable();
        } catch (error) {
            expect((error as AgentAuthError).code).toBe('MISSING_ABILITY');
        }
    });

    it('never mentions a brand in error messages', () => {
        const messages: string[] = [];
        const probes: Array<() => void> = [
            () => resolveAgentPrincipal(undefined),
            () =>
                resolveAgentPrincipal(
                    sessionCredential({ userType: 'anonymous' }),
                ),
            () => resolveAgentPrincipal(sessionCredential({ userUuid: '' })),
        ];
        for (const probe of probes) {
            try {
                probe();
            } catch (error) {
                messages.push(String((error as Error).message));
            }
        }
        expect(messages.length).toBeGreaterThan(0);
        for (const message of messages) {
            expect(message.toLowerCase()).not.toContain('lightdash');
        }
    });
});

describe('hashUserAttributes', () => {
    it('is stable regardless of key and value order', () => {
        const first = hashUserAttributes({ b: ['2', '1'], a: ['x'] });
        const second = hashUserAttributes({ a: ['x'], b: ['1', '2'] });
        expect(first).toBe(second);
    });

    it('changes when values change and ignores non-string entries', () => {
        const base = hashUserAttributes({ region: ['eu'] });
        expect(hashUserAttributes({ region: ['us'] })).not.toBe(base);
        expect(
            hashUserAttributes({
                region: ['eu', 42 as unknown as string],
            }),
        ).toBe(base);
        expect(hashUserAttributes({})).not.toBe(base);
    });
});

describe('buildAgentCacheKey', () => {
    it('binds auth type, user, org and attribute hash', () => {
        const key = buildAgentCacheKey({
            authType: 'pat',
            userUuid: 'u1',
            organizationUuid: 'o1',
            userAttributesHash: 'abcdef12',
        });
        expect(key).toBe('pat:u1:o1:abcdef12');
    });
});

describe('diagnoseAuthorizationHeader', () => {
    it('returns null when no header is present', () => {
        expect(diagnoseAuthorizationHeader(undefined)).toBeNull();
        expect(diagnoseAuthorizationHeader('')).toBeNull();
    });

    it('returns null for well-formed ApiKey and Bearer schemes', () => {
        expect(
            diagnoseAuthorizationHeader(`ApiKey ${samplePatToken()}`),
        ).toBeNull();
        expect(diagnoseAuthorizationHeader('Bearer opaque-oauth')).toBeNull();
    });

    it('diagnoses a PAT sent as a Bearer token with 401', () => {
        const token = samplePatToken();
        const error = diagnoseAuthorizationHeader(`Bearer ${token}`);
        expect(error).toBeInstanceOf(AgentAuthError);
        expect(error?.statusCode).toBe(401);
        expect(error?.code).toBe('BEARER_PAT_MISUSE');
        expect(error?.message).toContain('ApiKey');
        expect(error?.message).not.toContain(token);
    });

    it('refuses service-account tokens sent as Bearer with 401', () => {
        const error = diagnoseAuthorizationHeader(
            `Bearer ${sampleServiceToken()}`,
        );
        expect(error).toBeInstanceOf(AgentAuthError);
        expect(error?.code).toBe('UNSUPPORTED_AUTH_TYPE');
    });

    it('ignores surrounding whitespace and scheme casing', () => {
        expect(
            diagnoseAuthorizationHeader(`  bearer ${samplePatToken()}  `)?.code,
        ).toBe('BEARER_PAT_MISUSE');
    });
});
