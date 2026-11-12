// Principal resolution for the agent extension (Slice A).
//
// This module is intentionally backend-agnostic: it takes an already
// authenticated per-user identity (resolved by the host app's session,
// OAuth2 or PAT middleware) and derives the AgentPrincipal the policy,
// guardrail and audit slices consume. It never accepts raw tokens or a
// shared static credential — per-user identity comes only from the host.
export type AgentAuthType = 'session' | 'oauth' | 'pat';

// Minimal ability surface the policy slice needs. The host passes its own
// CASL ability object; structural typing keeps this package dependency-free.
export interface AgentAbility {
    can(action: string, subject: string): boolean;
}

export type UserAttributeMap = Record<string, string[]>;

export interface AgentPrincipal {
    userUuid: string;
    organizationUuid: string;
    authType: AgentAuthType;
    ability: AgentAbility;
    userAttributesHash: string;
    cacheKey: string;
}

// Per-user identity as produced by the host auth layer. authType is limited
// to the three human credential kinds; anything else is refused downstream.
export interface ResolvedCredential {
    authType: AgentAuthType | string;
    userUuid: unknown;
    organizationUuid: unknown;
    ability: AgentAbility | unknown;
    userAttributes?: unknown;
    userType?: unknown;
}

export type AgentAuthErrorCode =
    | 'MISSING_CREDENTIALS'
    | 'NOT_REGISTERED_USER'
    | 'UNSUPPORTED_AUTH_TYPE'
    | 'INVALID_IDENTITY'
    | 'MISSING_ABILITY'
    | 'BEARER_PAT_MISUSE';

export class AgentAuthError extends Error {
    readonly statusCode = 401;

    readonly code: AgentAuthErrorCode;

    constructor(code: AgentAuthErrorCode, message: string) {
        super(message);
        this.name = 'AgentAuthError';
        this.code = code;
    }
}

const SUPPORTED_AUTH_TYPES: readonly string[] = ['session', 'oauth', 'pat'];

const PAT_PREFIX = 'ldpat_';

const SERVICE_ACCOUNT_PREFIX = 'ldsvc_';

// Canonicalize attribute maps so key/value order never changes the hash.
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

// djb2 (mod 2^32) over the canonical form. A non-cryptographic hash is
// enough: the value only isolates per-user cache entries, it grants nothing.
export function hashUserAttributes(value: unknown): string {
    const canonical = JSON.stringify(canonicalizeAttributes(value));
    let hash = 5381;
    for (let index = 0; index < canonical.length; index += 1) {
        hash = (hash * 33 + canonical.charCodeAt(index)) % 4294967296;
    }
    return hash.toString(16).padStart(8, '0');
}

export function buildAgentCacheKey(parts: {
    authType: AgentAuthType;
    userUuid: string;
    organizationUuid: string;
    userAttributesHash: string;
}): string {
    return `${parts.authType}:${parts.userUuid}:${parts.organizationUuid}:${parts.userAttributesHash}`;
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveAgentPrincipal(
    credential: ResolvedCredential | null | undefined,
): AgentPrincipal {
    if (!credential) {
        throw new AgentAuthError(
            'MISSING_CREDENTIALS',
            'Authentication required: sign in with a session, an OAuth2 Bearer token, or a personal access token.',
        );
    }
    if (credential.userType !== undefined && credential.userType !== null) {
        const userType =
            typeof credential.userType === 'string' ? credential.userType : '';
        if (userType !== 'registered') {
            throw new AgentAuthError(
                'NOT_REGISTERED_USER',
                'Only registered users may use the agent extension.',
            );
        }
    }
    if (!SUPPORTED_AUTH_TYPES.includes(credential.authType)) {
        throw new AgentAuthError(
            'UNSUPPORTED_AUTH_TYPE',
            `Authentication type "${typeof credential.authType === 'string' ? credential.authType : 'unknown'}" is not accepted by the agent extension.`,
        );
    }
    const userUuid = asNonEmptyString(credential.userUuid);
    const organizationUuid = asNonEmptyString(credential.organizationUuid);
    if (!userUuid || !organizationUuid) {
        throw new AgentAuthError(
            'INVALID_IDENTITY',
            'The authenticated identity is missing a user or organization reference.',
        );
    }
    const ability = credential.ability as AgentAbility | null | undefined;
    if (!ability || typeof ability.can !== 'function') {
        throw new AgentAuthError(
            'MISSING_ABILITY',
            'The authenticated identity carries no usable permission set.',
        );
    }
    const authType = credential.authType as AgentAuthType;
    const userAttributesHash = hashUserAttributes(credential.userAttributes);
    return {
        userUuid,
        organizationUuid,
        authType,
        ability,
        userAttributesHash,
        cacheKey: buildAgentCacheKey({
            authType,
            userUuid,
            organizationUuid,
            userAttributesHash,
        }),
    };
}

// Header-level triage for the host middleware: spots a personal access token
// (or service-account token) mistakenly sent as an OAuth2 Bearer token and
// returns a 401 with a fix. Returns null when the header needs no triage;
// absence of a header is reported later as MISSING_CREDENTIALS.
export function diagnoseAuthorizationHeader(
    header: string | undefined,
): AgentAuthError | null {
    if (header === undefined) {
        return null;
    }
    const trimmed = header.trim();
    if (trimmed.length === 0) {
        return null;
    }
    const match = /^([A-Za-z]+)\s+(\S+)\s*$/.exec(trimmed);
    if (!match) {
        return null;
    }
    const scheme = match[1].toLowerCase();
    const token = match[2];
    if (scheme !== 'bearer') {
        return null;
    }
    if (token.startsWith(PAT_PREFIX)) {
        return new AgentAuthError(
            'BEARER_PAT_MISUSE',
            'This looks like a personal access token sent as a Bearer token. Send it as "Authorization: ApiKey <token>" instead.',
        );
    }
    if (token.startsWith(SERVICE_ACCOUNT_PREFIX)) {
        return new AgentAuthError(
            'UNSUPPORTED_AUTH_TYPE',
            'Service account credentials are not accepted by the agent extension.',
        );
    }
    return null;
}
