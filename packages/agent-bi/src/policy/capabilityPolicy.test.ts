import { describe, expect, it } from 'vitest';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import {
    createUserRateLimiter,
    defaultCapabilityToggles,
    evaluateCapability,
    listAllowedCapabilities,
    type AgentCapabilityToggles,
} from './capabilityPolicy';

const abilityAllowing = (rules: ReadonlyArray<readonly [string, string]>) => ({
    can: (action: string, subject: string): boolean =>
        rules.some(([ruleAction, ruleSubject]) => {
            if (ruleSubject !== subject) {
                return false;
            }
            return ruleAction === 'manage' || ruleAction === action;
        }),
});

const principalWith = (
    ability: AgentPrincipal['ability'],
    userUuid = 'user-uuid-1',
): AgentPrincipal => ({
    userUuid,
    organizationUuid: 'org-uuid-1',
    authType: 'session',
    ability,
    userAttributesHash: 'abcdef01',
    cacheKey: `session:${userUuid}:org-uuid-1:abcdef01`,
});

// Mirrors the host CASL grants: plain viewers see projects but run no
// queries; interactive viewers gain Explore and ScheduledDeliveries;
// editors gain ContentAsCode; developers gain SqlRunner.
const viewerAbility = abilityAllowing([['view', 'Project']]);

const interactiveViewerAbility = abilityAllowing([
    ['view', 'Project'],
    ['manage', 'Explore'],
    ['create', 'ScheduledDeliveries'],
]);

const editorAbility = abilityAllowing([
    ['view', 'Project'],
    ['manage', 'Explore'],
    ['create', 'ScheduledDeliveries'],
    ['create', 'ContentAsCode'],
]);

const developerAbility = abilityAllowing([
    ['view', 'Project'],
    ['manage', 'Explore'],
    ['create', 'ScheduledDeliveries'],
    ['create', 'ContentAsCode'],
    ['manage', 'SqlRunner'],
]);

const allEnabled: AgentCapabilityToggles = {
    discover: true,
    metric_query: true,
    compose_query: true,
    content_write: true,
    export: true,
    raw_sql: true,
};

describe('evaluateCapability', () => {
    it('lets a viewer discover but denies metric_query', () => {
        const principal = principalWith(viewerAbility);
        expect(
            evaluateCapability(principal, 'discover', {
                toggles: allEnabled,
            }).allowed,
        ).toBe(true);
        const verdict = evaluateCapability(principal, 'metric_query', {
            toggles: allEnabled,
        });
        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('INSUFFICIENT_PERMISSIONS');
        }
    });

    it('applies editor rules across every capability', () => {
        const principal = principalWith(editorAbility);
        const context = { toggles: allEnabled };
        expect(evaluateCapability(principal, 'discover', context).allowed).toBe(
            true,
        );
        expect(
            evaluateCapability(principal, 'metric_query', context).allowed,
        ).toBe(true);
        expect(
            evaluateCapability(principal, 'compose_query', context).allowed,
        ).toBe(true);
        expect(
            evaluateCapability(principal, 'content_write', context).allowed,
        ).toBe(true);
        expect(evaluateCapability(principal, 'export', context).allowed).toBe(
            true,
        );
        expect(evaluateCapability(principal, 'raw_sql', context).allowed).toBe(
            false,
        );
    });

    it('denies raw_sql by default even for developers', () => {
        const principal = principalWith(developerAbility);
        const verdict = evaluateCapability(principal, 'raw_sql', {
            toggles: defaultCapabilityToggles(),
        });
        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('CAPABILITY_DISABLED');
        }
        expect(
            evaluateCapability(principal, 'raw_sql', { toggles: allEnabled })
                .allowed,
        ).toBe(true);
    });

    it('denies a disabled toggle before checking permissions', () => {
        const principal = principalWith(developerAbility);
        const verdict = evaluateCapability(principal, 'export', {
            toggles: { ...allEnabled, export: false },
        });
        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('CAPABILITY_DISABLED');
        }
    });

    it('denies unknown capabilities fail-closed', () => {
        const verdict = evaluateCapability(
            principalWith(developerAbility),
            'drop_tables',
            {
                toggles: allEnabled,
            },
        );
        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('UNKNOWN_CAPABILITY');
        }
    });

    it('denies fail-closed when the ability check throws or is missing', () => {
        const throwing = principalWith({
            can: () => {
                throw new Error('ability exploded');
            },
        });
        const verdict = evaluateCapability(throwing, 'discover', {
            toggles: allEnabled,
        });
        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('INSUFFICIENT_PERMISSIONS');
        }
        const missing = {
            ...principalWith(viewerAbility),
            ability: undefined,
        } as unknown as AgentPrincipal;
        expect(
            evaluateCapability(missing, 'discover', { toggles: allEnabled })
                .allowed,
        ).toBe(false);
    });

    it('keeps every denial message brand-free', () => {
        const principal = principalWith(viewerAbility);
        const verdicts = [
            evaluateCapability(principal, 'metric_query', {
                toggles: allEnabled,
            }),
            evaluateCapability(principal, 'export', {
                toggles: { ...allEnabled, export: false },
            }),
            evaluateCapability(principal, 'nope', { toggles: allEnabled }),
        ];
        for (const verdict of verdicts) {
            if (!verdict.allowed) {
                expect(verdict.message).not.toMatch(/lightdash/i);
            }
        }
    });
});

describe('createUserRateLimiter', () => {
    it('denies past the limit and recovers after the window', () => {
        let now = 0;
        const limiter = createUserRateLimiter(
            { maxRequests: 2, windowMs: 1000 },
            { now: () => now },
        );
        const principal = principalWith(interactiveViewerAbility);
        const context = () => ({
            toggles: allEnabled,
            rateLimiter: limiter,
        });
        expect(
            evaluateCapability(principal, 'discover', context()).allowed,
        ).toBe(true);
        expect(
            evaluateCapability(principal, 'discover', context()).allowed,
        ).toBe(true);
        const limited = evaluateCapability(principal, 'discover', context());
        expect(limited.allowed).toBe(false);
        if (!limited.allowed) {
            expect(limited.reason).toBe('RATE_LIMITED');
        }
        now += 1001;
        expect(
            evaluateCapability(principal, 'discover', context()).allowed,
        ).toBe(true);
    });

    it('isolates limits per user cache key', () => {
        let now = 0;
        const limiter = createUserRateLimiter(
            { maxRequests: 1, windowMs: 1000 },
            { now: () => now },
        );
        const first = principalWith(interactiveViewerAbility, 'user-uuid-1');
        const second = principalWith(interactiveViewerAbility, 'user-uuid-2');
        expect(
            evaluateCapability(first, 'discover', {
                toggles: allEnabled,
                rateLimiter: limiter,
            }).allowed,
        ).toBe(true);
        expect(
            evaluateCapability(second, 'discover', {
                toggles: allEnabled,
                rateLimiter: limiter,
            }).allowed,
        ).toBe(true);
        expect(
            evaluateCapability(first, 'discover', {
                toggles: allEnabled,
                rateLimiter: limiter,
            }).allowed,
        ).toBe(false);
    });
});

describe('listAllowedCapabilities', () => {
    it('reports the effective set for a viewer and an editor', () => {
        expect(
            listAllowedCapabilities(principalWith(viewerAbility), allEnabled),
        ).toEqual(['discover']);
        expect(
            listAllowedCapabilities(principalWith(editorAbility), allEnabled),
        ).toEqual([
            'discover',
            'metric_query',
            'compose_query',
            'content_write',
            'export',
        ]);
    });
});
