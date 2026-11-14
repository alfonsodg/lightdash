import { z } from 'zod';
import {
    recordAuditEvent,
    sanitizeAuditInput,
    type AuditVerdictSource,
} from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import type { CatalogSearchHit } from '../catalog/catalogIndexer';
import { evaluateCapability } from '../policy/capabilityPolicy';
import {
    AgentToolError,
    type AgentToolRuntimeOptions,
} from './agentToolTypes';
import {
    DISCOVER_CAPABILITY,
    type DiscoveryFetch,
    type DiscoveryFetchClientOptions,
    type DiscoveryToolDeps,
    type DiscoveryToolName,
} from './discoverySchemas';

export type InvokeFn = () => Promise<unknown>;

export const buildExploresPath = (projectUuid: string): string =>
    `/api/v1/projects/${encodeURIComponent(projectUuid)}/explores`;

export const buildExplorePath = (
    projectUuid: string,
    exploreId: string,
): string =>
    `/api/v1/projects/${encodeURIComponent(projectUuid)}/explores/${encodeURIComponent(exploreId)}`;

export const buildMetricMetadataPath = (
    projectUuid: string,
    tableName: string,
    metricName: string,
): string =>
    `/api/v1/projects/${encodeURIComponent(projectUuid)}/dataCatalog/metrics/${encodeURIComponent(tableName)}/${encodeURIComponent(metricName)}`;

export const buildWarehouseFieldsPath = (projectUuid: string): string =>
    `/api/v1/projects/${encodeURIComponent(projectUuid)}/sqlRunner/fields`;

export const CONTENT_LIST_PATH = '/api/v2/content';

export const unwrapResults = (json: unknown): unknown => {
    if (json !== null && typeof json === 'object' && 'results' in json) {
        return (json as { results: unknown }).results;
    }
    return json;
};

export const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

const asArray = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : [];

const nullableText = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

export const toExploreSummaries = (results: unknown): unknown => {
    const entries = Array.isArray(results)
        ? results
        : asArray(asRecord(results).explores);
    const explores = entries
        .map((entry) => asRecord(entry))
        .filter((entry) => typeof entry.name === 'string')
        .map((entry) => ({
            description: nullableText(entry.description),
            label: nullableText(entry.label),
            name: entry.name as string,
            tags: asArray(entry.tags).filter(
                (tag): tag is string => typeof tag === 'string',
            ),
        }));
    return { explores };
};

export const toExploreDetail = (results: unknown): unknown => {
    const record = asRecord(results);
    const tables = asRecord(record.tables);
    return {
        explore: {
            baseTable: nullableText(record.baseTable),
            description: nullableText(record.description),
            label: nullableText(record.label),
            name:
                typeof record.name === 'string' && record.name.length > 0
                    ? record.name
                    : 'unknown',
            tables: Object.keys(tables),
        },
    };
};

const MAX_SNIPPET_CHARS = 500;

export const toCatalogHits = (hits: readonly CatalogSearchHit[]): unknown => ({
    hits: hits.map((hit) => ({
        content:
            hit.document.content.length > MAX_SNIPPET_CHARS
                ? `${hit.document.content.slice(0, MAX_SNIPPET_CHARS)}…`
                : hit.document.content,
        exploreName: hit.document.exploreName,
        fieldName: hit.document.fieldName,
        resourceType: hit.document.resourceType,
        score: hit.score,
        tableName: hit.document.tableName,
    })),
});

export const toWarehouseColumns = (
    results: unknown,
    schemaName: string,
    tableName: string,
): unknown => {
    const record = asRecord(results);
    const columns = Object.entries(record)
        .filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
        )
        .map(([name, type]) => ({ name, type }));
    return { columns, schemaName, tableName };
};

export const toContentItems = (results: unknown): unknown => {
    const record = asRecord(results);
    const items = Array.isArray(results)
        ? results
        : asArray(record.data ?? record.items ?? record.content);
    return { items: items.map((item) => asRecord(item)) };
};

export const createDiscoveryFetchClient = (
    options: DiscoveryFetchClientOptions,
): DiscoveryFetch => {
    if (!options.baseUrl || !options.baseUrl.trim()) {
        throw new AgentToolError(
            'INVALID_INPUT',
            'A base URL is required for discovery requests.',
        );
    }
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    return async (request) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(request.query ?? {})) {
            if (value !== undefined) {
                params.set(key, value);
            }
        }
        const suffix = params.size > 0 ? `?${params.toString()}` : '';
        let response: Response;
        try {
            response = await fetchImpl(`${baseUrl}${request.path}${suffix}`, {
                headers: {
                    Accept: 'application/json',
                    ...(options.headers ?? {}),
                },
                method: request.method,
            });
        } catch {
            throw new AgentToolError(
                'UPSTREAM_ERROR',
                'The discovery request failed before reaching the server.',
            );
        }
        if (response.status < 200 || response.status >= 300) {
            throw new AgentToolError(
                'UPSTREAM_ERROR',
                `The discovery request failed (status ${response.status}).`,
            );
        }
        const text = await response.text();
        if (!text) {
            return null;
        }
        try {
            return JSON.parse(text) as unknown;
        } catch {
            throw new AgentToolError(
                'UPSTREAM_ERROR',
                'The server returned a response the tool could not read.',
            );
        }
    };
};

export const runGuardedDiscovery = async (
    deps: DiscoveryToolDeps,
    tool: DiscoveryToolName,
    input: { projectUuid: string },
    principal: AgentPrincipal,
    options: AgentToolRuntimeOptions,
    outputSchema: z.ZodType<unknown>,
    invoke: InvokeFn,
    rowCountOf: (result: unknown) => number | null,
): Promise<unknown> => {
    void options;
    const startedAt = Date.now();
    const auditBase = {
        capability: DISCOVER_CAPABILITY,
        principal: {
            organizationUuid: principal.organizationUuid,
            userUuid: principal.userUuid,
        },
        projectUuid: input.projectUuid,
        tool,
    };
    const policyVerdict = evaluateCapability(
        principal,
        DISCOVER_CAPABILITY,
        deps.policyContext,
    );
    if (!policyVerdict.allowed) {
        const source: AuditVerdictSource = {
            allowed: false,
            reason: policyVerdict.reason,
        };
        await recordAuditEvent(deps.auditClient, {
            ...auditBase,
            input: sanitizeAuditInput(input),
            policyVerdict: source,
            reason: policyVerdict.message,
            verdict: 'deny',
        });
        throw new AgentToolError(
            'POLICY_DENIED',
            'The current user lacks permission for this action.',
            policyVerdict.reason,
        );
    }
    try {
        const raw = await invoke();
        const result = outputSchema.parse(raw);
        await recordAuditEvent(deps.auditClient, {
            ...auditBase,
            input: sanitizeAuditInput(input),
            latencyMs: Date.now() - startedAt,
            policyVerdict: { allowed: true },
            rowCount: rowCountOf(result),
            verdict: 'allow',
        });
        return result;
    } catch (error) {
        if (error instanceof AgentToolError && error.code === 'POLICY_DENIED') {
            throw error;
        }
        const reason =
            error instanceof AgentToolError ? error.code : 'UPSTREAM_ERROR';
        const message =
            error instanceof AgentToolError
                ? error.message
                : 'The request failed before rows could be returned.';
        await recordAuditEvent(deps.auditClient, {
            ...auditBase,
            input: sanitizeAuditInput(input),
            latencyMs: Date.now() - startedAt,
            reason,
            verdict: 'deny',
        });
        if (error instanceof AgentToolError) {
            throw error;
        }
        throw new AgentToolError('UPSTREAM_ERROR', message, reason);
    }
};
