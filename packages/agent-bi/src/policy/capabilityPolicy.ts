import type { AgentPrincipal } from '../auth/agentPrincipal';

// Agent capabilities gated by this policy. Each one pairs a user CASL
// permission with an agent toggle; both must pass for the verdict to allow.
export type AgentCapability =
    | 'discover'
    | 'metric_query'
    | 'compose_query'
    | 'content_write'
    | 'export'
    | 'raw_sql';

export type AgentCapabilityToggles = Record<AgentCapability, boolean>;

// Raw SQL stays off unless the host deployment explicitly enables it.
export function defaultCapabilityToggles(): AgentCapabilityToggles {
    return {
        discover: true,
        metric_query: true,
        compose_query: true,
        content_write: true,
        export: true,
        raw_sql: false,
    };
}

const ALL_CAPABILITIES: readonly AgentCapability[] = [
    'discover',
    'metric_query',
    'compose_query',
    'content_write',
    'export',
    'raw_sql',
];

// CASL permission each capability intersects with. `manage` on the host
// ability implies `view`, so editors (manage:Explore) satisfy view:Explore
// while plain viewers satisfy neither.
const CAPABILITY_REQUIREMENTS: Record<
    AgentCapability,
    { action: string; subject: string }
> = {
    discover: { action: 'view', subject: 'Project' },
    metric_query: { action: 'view', subject: 'Explore' },
    compose_query: { action: 'view', subject: 'Explore' },
    content_write: { action: 'create', subject: 'ContentAsCode' },
    export: { action: 'create', subject: 'ScheduledDeliveries' },
    raw_sql: { action: 'manage', subject: 'SqlRunner' },
};

export type PolicyDenyReason =
    | 'UNKNOWN_CAPABILITY'
    | 'CAPABILITY_DISABLED'
    | 'RATE_LIMITED'
    | 'INSUFFICIENT_PERMISSIONS';

export type PolicyVerdict =
    | { allowed: true; capability: AgentCapability }
    | {
          allowed: false;
          capability: string;
          reason: PolicyDenyReason;
          message: string;
      };

export interface RateLimitOptions {
    maxRequests: number;
    windowMs: number;
}

export interface RateLimitClock {
    now(): number;
}

export interface UserRateLimiter {
    check(key: string): boolean;
}

// Sliding-window limiter keyed by the caller. Callers pass the principal
// cacheKey so limits stay per user, per org, per auth type and attributes.
export function createUserRateLimiter(
    options: RateLimitOptions,
    clock: RateLimitClock = { now: () => Date.now() },
): UserRateLimiter {
    const maxRequests = Math.max(1, Math.floor(options.maxRequests));
    const windowMs = Math.max(1, options.windowMs);
    const hitsByKey = new Map<string, number[]>();
    return {
        check(key: string): boolean {
            const now = clock.now();
            const cutoff = now - windowMs;
            const recent = (hitsByKey.get(key) ?? []).filter(
                (stamp) => stamp > cutoff,
            );
            if (recent.length >= maxRequests) {
                hitsByKey.set(key, recent);
                return false;
            }
            recent.push(now);
            hitsByKey.set(key, recent);
            return true;
        },
    };
}

export interface CapabilityPolicyContext {
    toggles: AgentCapabilityToggles;
    rateLimiter?: UserRateLimiter;
}

const isKnownCapability = (value: string): value is AgentCapability =>
    (ALL_CAPABILITIES as readonly string[]).includes(value);

function hasPermission(
    principal: AgentPrincipal,
    capability: AgentCapability,
): boolean {
    const { ability } = principal;
    if (!ability || typeof ability.can !== 'function') {
        return false;
    }
    const requirement = CAPABILITY_REQUIREMENTS[capability];
    try {
        return ability.can(requirement.action, requirement.subject);
    } catch {
        return false;
    }
}

// Intersection gate: unknown capabilities, disabled toggles, exhausted rate
// limits and missing CASL permissions all deny. Nothing here permits.
export function evaluateCapability(
    principal: AgentPrincipal,
    capability: string,
    context: CapabilityPolicyContext,
): PolicyVerdict {
    if (!isKnownCapability(capability)) {
        return {
            allowed: false,
            capability,
            reason: 'UNKNOWN_CAPABILITY',
            message: `Capability "${capability}" is not recognized and was denied.`,
        };
    }
    if (context.toggles[capability] !== true) {
        return {
            allowed: false,
            capability,
            reason: 'CAPABILITY_DISABLED',
            message: `Capability "${capability}" is disabled for this deployment.`,
        };
    }
    if (
        context.rateLimiter !== undefined &&
        !context.rateLimiter.check(principal.cacheKey)
    ) {
        return {
            allowed: false,
            capability,
            reason: 'RATE_LIMITED',
            message: `Capability "${capability}" is temporarily rate limited for this user. Try again later.`,
        };
    }
    if (!hasPermission(principal, capability)) {
        return {
            allowed: false,
            capability,
            reason: 'INSUFFICIENT_PERMISSIONS',
            message: `The current user lacks permission for capability "${capability}".`,
        };
    }
    return { allowed: true, capability };
}

// Effective capability set for one principal: used by the preflight surface.
export function listAllowedCapabilities(
    principal: AgentPrincipal,
    toggles: AgentCapabilityToggles,
): AgentCapability[] {
    return ALL_CAPABILITIES.filter(
        (capability) =>
            evaluateCapability(principal, capability, { toggles }).allowed,
    );
}
