import type { Request } from 'express';

// Backend-local principal resolution + capability preflight for the agent
// extension (Phase 2, Slice E). This module intentionally duplicates the
// small Slice A/B contracts instead of importing the extension package, so
// the backend extension router keeps the Phase-1 dependency boundary (see
// `agentBiRouter.test.ts`: the router source must not reference the
// extension package). Keep the shapes aligned with
// `packages/agent-bi/src/auth/agentPrincipal.ts` and
// `packages/agent-bi/src/policy/capabilityPolicy.ts` through the
// cross-slice refs, never by importing them here.
export type AgentPreflightAuthType = 'session' | 'oauth' | 'pat';

export interface AgentPreflightAbility {
    can(action: string, subject: string): boolean;
}

export interface AgentPreflightPrincipal {
    userUuid: string;
    organizationUuid: string;
    authType: AgentPreflightAuthType;
    ability: AgentPreflightAbility;
    userAttributesHash: string;
    cacheKey: string;
}

export type AgentPreflightCapability =
    | 'discover'
    | 'metric_query'
    | 'compose_query'
    | 'content_write'
    | 'export'
    | 'raw_sql';

export type AgentPreflightToggles = Record<AgentPreflightCapability, boolean>;

export type AgentPreflightErrorCode =
    | 'MISSING_CREDENTIALS'
    | 'NOT_REGISTERED_USER'
    | 'UNSUPPORTED_AUTH_TYPE'
    | 'INVALID_IDENTITY'
    | 'MISSING_ABILITY';

export class AgentPreflightError extends Error {
    readonly statusCode = 401;

    readonly code: AgentPreflightErrorCode;

    constructor(code: AgentPreflightErrorCode, message: string) {
        super(message);
        this.name = 'AgentPreflightError';
        this.code = code;
    }
}

// Raw SQL stays off unless the deployment explicitly enables it later. The
// toggle alone never authorizes execution: approval, warehouse-enforced
// read-only identity and the AST guard stay mandatory downstream.
export function defaultPreflightToggles(): AgentPreflightToggles {
    return {
        discover: true,
        metric_query: true,
        compose_query: true,
        content_write: true,
        export: true,
        raw_sql: false,
    };
}

const ALL_CAPABILITIES: readonly AgentPreflightCapability[] = [
    'discover',
    'metric_query',
    'compose_query',
    'content_write',
    'export',
    'raw_sql',
];

const CAPABILITY_REQUIREMENTS: Record<
    AgentPreflightCapability,
    { action: string; subject: string }
> = {
    discover: { action: 'view', subject: 'Project' },
    metric_query: { action: 'view', subject: 'Explore' },
    compose_query: { action: 'view', subject: 'Explore' },
    content_write: { action: 'create', subject: 'ContentAsCode' },
    export: { action: 'create', subject: 'ScheduledDeliveries' },
    raw_sql: { action: 'manage', subject: 'SqlRunner' },
};

function canonicalizeAttributes(value: unknown): Array<[string, string[]]> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [];
    }
    const entries: Array<[string, string[]]> = [];
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (typeof key === 'string' && key.length > 0) {
            const values = Array.isArray(raw) ? raw : [raw];
            const kept = values.filter(
                (entry): entry is string =>
                    typeof entry === 'string' && entry.length > 0,
            );
            kept.sort();
            entries.push([key, kept]);
        }
    }
    entries.sort((first, second) => {
        if (first[0] === second[0]) {
            return 0;
        }
        return first[0] < second[0] ? -1 : 1;
    });
    return entries;
}

// djb2 (mod 2^32) over canonical JSON. Matches the Slice A hasher so cache
// keys stay comparable; non-cryptographic on purpose, isolation only.
export function hashPreflightAttributes(value: unknown): string {
    const canonical = JSON.stringify(canonicalizeAttributes(value));
    let hash = 5381;
    for (let index = 0; index < canonical.length; index += 1) {
        hash = (hash * 33 + canonical.charCodeAt(index)) % 4294967296;
    }
    return hash.toString(16).padStart(8, '0');
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

interface PreflightIdentity {
    authType: string;
    userUuid: unknown;
    organizationUuid: unknown;
    ability: unknown;
    userType: unknown;
    userAttributes: unknown;
}

function readIdentity(req: Request): PreflightIdentity | null {
    const account = req.account as
        | {
              authentication?: { type?: unknown };
              organization?: { organizationUuid?: unknown };
              user?: {
                  userUuid?: unknown;
                  type?: unknown;
                  ability?: unknown;
                  userAttributes?: unknown;
              };
          }
        | undefined;
    if (account) {
        return {
            authType:
                typeof account.authentication?.type === 'string'
                    ? account.authentication.type
                    : 'unknown',
            userUuid: account.user?.userUuid,
            organizationUuid: account.organization?.organizationUuid,
            ability: account.user?.ability,
            userType: account.user?.type,
            userAttributes: account.user?.userAttributes ?? {},
        };
    }
    const user = req.user as
        | {
              userUuid?: unknown;
              organizationUuid?: unknown;
              ability?: unknown;
              userAttributes?: unknown;
          }
        | undefined;
    if (user) {
        return {
            authType: 'session',
            userUuid: user.userUuid,
            organizationUuid: user.organizationUuid,
            ability: user.ability,
            userType: 'registered',
            userAttributes: user.userAttributes ?? {},
        };
    }
    return null;
}

// Auth-first principal resolution. Runs after `isAuthenticated`, so a
// missing identity here means the middleware chain was bypassed; every
// failure is a 401 and nothing about tokens or secrets is echoed.
export function resolvePreflightPrincipal(
    req: Request,
): AgentPreflightPrincipal {
    const identity = readIdentity(req);
    if (!identity) {
        throw new AgentPreflightError(
            'MISSING_CREDENTIALS',
            'Authentication is required to use the agent extension.',
        );
    }
    if (
        identity.authType !== 'session' &&
        identity.authType !== 'oauth' &&
        identity.authType !== 'pat'
    ) {
        throw new AgentPreflightError(
            'UNSUPPORTED_AUTH_TYPE',
            'This credential type is not accepted by the agent extension.',
        );
    }
    if (
        identity.userType !== undefined &&
        identity.userType !== null &&
        identity.userType !== 'registered'
    ) {
        throw new AgentPreflightError(
            'NOT_REGISTERED_USER',
            'Only registered users may use the agent extension.',
        );
    }
    const userUuid = asNonEmptyString(identity.userUuid);
    const organizationUuid = asNonEmptyString(identity.organizationUuid);
    if (!userUuid || !organizationUuid) {
        throw new AgentPreflightError(
            'INVALID_IDENTITY',
            'The authenticated identity is missing a user or organization reference.',
        );
    }
    const { ability } = identity as { ability: AgentPreflightAbility };
    if (!ability || typeof ability.can !== 'function') {
        throw new AgentPreflightError(
            'MISSING_ABILITY',
            'The authenticated identity carries no usable permission set.',
        );
    }
    const authType = identity.authType as AgentPreflightAuthType;
    const userAttributesHash = hashPreflightAttributes(
        identity.userAttributes ?? {},
    );
    return {
        userUuid,
        organizationUuid,
        authType,
        ability,
        userAttributesHash,
        cacheKey: `${authType}:${userUuid}:${organizationUuid}:${userAttributesHash}`,
    };
}

export type PreflightVerdict =
    | { allowed: true; capability: AgentPreflightCapability }
    | {
          allowed: false;
          capability: AgentPreflightCapability;
          reason:
              | 'CAPABILITY_DISABLED'
              | 'INSUFFICIENT_PERMISSIONS'
              | 'UNKNOWN_CAPABILITY';
          message: string;
      };

export type PreflightVerdicts = Record<
    AgentPreflightCapability,
    PreflightVerdict
>;

// Intersection gate mirroring the Slice B policy: a deployment toggle AND
// the user's own CASL permission must both pass. Fail-closed throughout.
export function evaluatePreflightCapabilities(
    principal: AgentPreflightPrincipal,
    toggles: AgentPreflightToggles = defaultPreflightToggles(),
): PreflightVerdicts {
    const verdicts = {} as PreflightVerdicts;
    for (const capability of ALL_CAPABILITIES) {
        if (toggles[capability] !== true) {
            verdicts[capability] = {
                allowed: false,
                capability,
                reason: 'CAPABILITY_DISABLED',
                message: `Capability "${capability}" is disabled for this deployment.`,
            };
        } else {
            const requirement = CAPABILITY_REQUIREMENTS[capability];
            let permitted = false;
            try {
                permitted = principal.ability.can(
                    requirement.action,
                    requirement.subject,
                );
            } catch {
                permitted = false;
            }
            if (permitted) {
                verdicts[capability] = { allowed: true, capability };
            } else {
                verdicts[capability] = {
                    allowed: false,
                    capability,
                    reason: 'INSUFFICIENT_PERMISSIONS',
                    message: `The current user lacks permission for capability "${capability}".`,
                };
            }
        }
    }
    return verdicts;
}

export function listPreflightCapabilityNames(
    principal: AgentPreflightPrincipal,
    toggles: AgentPreflightToggles = defaultPreflightToggles(),
): AgentPreflightCapability[] {
    const verdicts = evaluatePreflightCapabilities(principal, toggles);
    return ALL_CAPABILITIES.filter(
        (capability) => verdicts[capability].allowed,
    );
}
