// Discovery tools (Slice C): read-only catalog, explore, content, field
// value, and warehouse-shape lookups. Query traffic uses the v2 async
// field-values API; authored reads use MIT discovery endpoints. No
// deprecated v1 route is referenced anywhere in this module.

import { z } from 'zod';
import {
    recordAuditEvent,
    sanitizeAuditInput,
    type AuditVerdictSource,
} from '../audit/auditLogger';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import type {
    CatalogSearchHit,
    CatalogVisibility,
} from '../catalog/catalogIndexer';
import type {
    LightdashV2Client,
    PollOptions,
    V2FieldValueSearchBody,
} from '../client/lightdashV2Client';
import { evaluateCapability } from '../policy/capabilityPolicy';
import {
    agentReadyPageSchema,
    AgentToolError,
    formatValidationError,
    pageSchema,
    pageSizeSchema,
    projectUuidSchema,
    type AgentReadyPage,
    type AgentToolBaseDeps,
    type AgentToolRuntimeOptions,
} from './agentToolTypes';

export { AgentToolError } from './agentToolTypes';

export const DISCOVERY_TOOL_NAMES = [
    'list_explores',
    'get_explore',
    'search_catalog_fields',
    'get_metric_metadata',
    'search_field_values',
    'list_spaces_and_content',
    'inspect_warehouse_columns',
] as const;

export type DiscoveryToolName = (typeof DISCOVERY_TOOL_NAMES)[number];

export const DISCOVER_CAPABILITY = 'discover';

const MAX_NAME_CHARS = 256;
const MAX_SEARCH_CHARS = 500;

const nameSchema = z.string().trim().min(1).max(MAX_NAME_CHARS);

export const listExploresInputSchema = z.object({
    projectUuid: projectUuidSchema,
});

export const getExploreInputSchema = z.object({
    exploreId: nameSchema,
    projectUuid: projectUuidSchema,
});

export const searchCatalogFieldsInputSchema = z.object({
    exploreName: nameSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
    projectUuid: projectUuidSchema,
    query: z.string().trim().min(1).max(MAX_SEARCH_CHARS),
});

export const getMetricMetadataInputSchema = z.object({
    metricName: nameSchema,
    projectUuid: projectUuidSchema,
    tableName: nameSchema,
});

export const searchFieldValuesInputSchema = z.object({
    fieldId: nameSchema,
    filters: z.record(z.string(), z.unknown()).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
    projectUuid: projectUuidSchema,
    search: z.string().trim().min(1).max(MAX_SEARCH_CHARS),
    table: nameSchema,
});

export const listSpacesAndContentInputSchema = z.object({
    contentTypes: z.array(z.string().min(1).max(64)).max(20).optional(),
    page: pageSchema,
    pageSize: z.number().int().min(1).max(1000).optional(),
    projectUuid: projectUuidSchema,
    search: z.string().trim().min(1).max(MAX_SEARCH_CHARS).optional(),
});

export const inspectWarehouseColumnsInputSchema = z.object({
    databaseName: nameSchema.optional(),
    projectUuid: projectUuidSchema,
    schemaName: nameSchema,
    tableName: nameSchema,
});

export type ListExploresInput = z.infer<typeof listExploresInputSchema>;
export type GetExploreInput = z.infer<typeof getExploreInputSchema>;
export type SearchCatalogFieldsInput = z.infer<
    typeof searchCatalogFieldsInputSchema
>;
export type GetMetricMetadataInput = z.infer<
    typeof getMetricMetadataInputSchema
>;
export type SearchFieldValuesInput = z.infer<
    typeof searchFieldValuesInputSchema
>;
export type ListSpacesAndContentInput = z.infer<
    typeof listSpacesAndContentInputSchema
>;
export type InspectWarehouseColumnsInput = z.infer<
    typeof inspectWarehouseColumnsInputSchema
>;

const exploreSummarySchema = z.object({
    description: z.string().nullable(),
    label: z.string().nullable(),
    name: z.string(),
    tags: z.array(z.string()),
});

export const listExploresOutputSchema = z.object({
    explores: z.array(exploreSummarySchema),
});

export const getExploreOutputSchema = z.object({
    explore: z.object({
        baseTable: z.string().nullable(),
        description: z.string().nullable(),
        label: z.string().nullable(),
        name: z.string(),
        tables: z.array(z.string()),
    }),
});

export const searchCatalogFieldsOutputSchema = z.object({
    hits: z.array(
        z.object({
            content: z.string(),
            exploreName: z.string(),
            fieldName: z.string().nullable(),
            resourceType: z.string(),
            score: z.number(),
            tableName: z.string().nullable(),
        }),
    ),
});

export const getMetricMetadataOutputSchema = z.object({
    details: z.unknown(),
    metricName: z.string(),
    tableName: z.string(),
});

export const searchFieldValuesOutputSchema = agentReadyPageSchema;

export const listSpacesAndContentOutputSchema = z.object({
    items: z.array(z.record(z.string(), z.unknown())),
});

export const inspectWarehouseColumnsOutputSchema = z.object({
    columns: z.array(z.object({ name: z.string(), type: z.string() })),
    schemaName: z.string(),
    tableName: z.string(),
});

export interface DiscoveryFetchRequest {
    method: 'GET';
    path: string;
    query?: Record<string, string | undefined>;
}

export type DiscoveryFetch = (
    request: DiscoveryFetchRequest,
) => Promise<unknown>;

// Injected catalog search (Slice A shapes); the fake in unit tests stands
// in for the indexed store plus caller-supplied visibility lists.
export interface CatalogFieldSearcher {
    search(
        query: string,
        visibility: CatalogVisibility,
        limit: number,
    ): Promise<CatalogSearchHit[]> | CatalogSearchHit[];
}

export type FieldValuesClient = Pick<
    LightdashV2Client,
    'executeFieldValueSearch' | 'pollQueryToReady'
>;

export interface DiscoveryToolDeps extends AgentToolBaseDeps {
    catalogSearch: CatalogFieldSearcher;
    discoveryFetch: DiscoveryFetch;
    fieldValuesClient: FieldValuesClient;
    defaultTimeoutMs?: number;
}

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

// Envelope-aware unwrap: MIT endpoints wrap payloads in { results }.
const unwrapResults = (json: unknown): unknown => {
    if (json !== null && typeof json === 'object' && 'results' in json) {
        return (json as { results: unknown }).results;
    }
    return json;
};

const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

const asArray = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : [];

const nullableText = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

const toExploreSummaries = (results: unknown): unknown => {
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

const toExploreDetail = (results: unknown): unknown => {
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

const toCatalogHits = (hits: readonly CatalogSearchHit[]): unknown => ({
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

const toWarehouseColumns = (
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

const toContentItems = (results: unknown): unknown => {
    const record = asRecord(results);
    const items = Array.isArray(results)
        ? results
        : asArray(record.data ?? record.items ?? record.content);
    return { items: items.map((item) => asRecord(item)) };
};

export interface DiscoveryFetchClientOptions {
    baseUrl: string;
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    headers?: Record<string, string>;
}

// Host-owned HTTP adapter behind the DiscoveryFetch seam: base URL and
// caller credentials come from the deploy environment, never from tools.
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

type InvokeFn = () => Promise<unknown>;

const runGuardedDiscovery = async (
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

export const createDiscoveryTools = (deps: DiscoveryToolDeps) => {
    const guard = (
        tool: DiscoveryToolName,
        input: { projectUuid: string },
        principal: AgentPrincipal,
        options: AgentToolRuntimeOptions,
        outputSchema: z.ZodType<unknown>,
        invoke: InvokeFn,
        rowCountOf: (result: unknown) => number | null = () => null,
    ): Promise<unknown> =>
        runGuardedDiscovery(
            deps,
            tool,
            input,
            principal,
            options,
            outputSchema,
            invoke,
            rowCountOf,
        );

    const handlers = {
        get_explore: (
            input: GetExploreInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'get_explore',
                input,
                principal,
                options,
                getExploreOutputSchema,
                async () =>
                    toExploreDetail(
                        unwrapResults(
                            await deps.discoveryFetch({
                                method: 'GET',
                                path: buildExplorePath(
                                    input.projectUuid,
                                    input.exploreId,
                                ),
                            }),
                        ),
                    ),
            ) as Promise<z.infer<typeof getExploreOutputSchema>>,

        get_metric_metadata: (
            input: GetMetricMetadataInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'get_metric_metadata',
                input,
                principal,
                options,
                getMetricMetadataOutputSchema,
                async () => ({
                    details: unwrapResults(
                        await deps.discoveryFetch({
                            method: 'GET',
                            path: buildMetricMetadataPath(
                                input.projectUuid,
                                input.tableName,
                                input.metricName,
                            ),
                        }),
                    ),
                    metricName: input.metricName,
                    tableName: input.tableName,
                }),
            ) as Promise<z.infer<typeof getMetricMetadataOutputSchema>>,

        inspect_warehouse_columns: (
            input: InspectWarehouseColumnsInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'inspect_warehouse_columns',
                input,
                principal,
                options,
                inspectWarehouseColumnsOutputSchema,
                async () =>
                    toWarehouseColumns(
                        unwrapResults(
                            await deps.discoveryFetch({
                                method: 'GET',
                                path: buildWarehouseFieldsPath(
                                    input.projectUuid,
                                ),
                                query: {
                                    databaseName: input.databaseName,
                                    schemaName: input.schemaName,
                                    tableName: input.tableName,
                                },
                            }),
                        ),
                        input.schemaName,
                        input.tableName,
                    ),
                (result) => (result as { columns: unknown[] }).columns.length,
            ) as Promise<z.infer<typeof inspectWarehouseColumnsOutputSchema>>,

        list_explores: (
            input: ListExploresInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'list_explores',
                input,
                principal,
                options,
                listExploresOutputSchema,
                async () =>
                    toExploreSummaries(
                        unwrapResults(
                            await deps.discoveryFetch({
                                method: 'GET',
                                path: buildExploresPath(input.projectUuid),
                            }),
                        ),
                    ),
                (result) => (result as { explores: unknown[] }).explores.length,
            ) as Promise<z.infer<typeof listExploresOutputSchema>>,

        list_spaces_and_content: (
            input: ListSpacesAndContentInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'list_spaces_and_content',
                input,
                principal,
                options,
                listSpacesAndContentOutputSchema,
                async () =>
                    toContentItems(
                        unwrapResults(
                            await deps.discoveryFetch({
                                method: 'GET',
                                path: CONTENT_LIST_PATH,
                                query: {
                                    contentTypes: input.contentTypes?.join(','),
                                    page:
                                        input.page === undefined
                                            ? undefined
                                            : String(input.page),
                                    pageSize:
                                        input.pageSize === undefined
                                            ? undefined
                                            : String(input.pageSize),
                                    projectUuids: input.projectUuid,
                                    search: input.search,
                                },
                            }),
                        ),
                    ),
                (result) => (result as { items: unknown[] }).items.length,
            ) as Promise<z.infer<typeof listSpacesAndContentOutputSchema>>,

        search_catalog_fields: (
            input: SearchCatalogFieldsInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'search_catalog_fields',
                input,
                principal,
                options,
                searchCatalogFieldsOutputSchema,
                async () => {
                    const { visibility } = options;
                    if (!visibility || visibility.allowedExplores.size === 0) {
                        throw new AgentToolError(
                            'INVALID_INPUT',
                            'Catalog search needs the caller visibility lists before it can filter hits.',
                        );
                    }
                    const hits = await deps.catalogSearch.search(
                        input.query,
                        visibility,
                        input.limit,
                    );
                    const scoped =
                        input.exploreName === undefined
                            ? hits
                            : hits.filter(
                                  (hit) =>
                                      hit.document.exploreName ===
                                      input.exploreName,
                              );
                    return toCatalogHits(scoped);
                },
                (result) => (result as { hits: unknown[] }).hits.length,
            ) as Promise<z.infer<typeof searchCatalogFieldsOutputSchema>>,

        search_field_values: (
            input: SearchFieldValuesInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'search_field_values',
                input,
                principal,
                options,
                searchFieldValuesOutputSchema,
                async () => {
                    const body: V2FieldValueSearchBody = {
                        fieldId: input.fieldId,
                        search: input.search,
                        table: input.table,
                        ...(input.filters !== undefined
                            ? { filters: input.filters }
                            : {}),
                        ...(input.limit !== undefined
                            ? { limit: input.limit }
                            : {}),
                    };
                    const executed =
                        await deps.fieldValuesClient.executeFieldValueSearch(
                            input.projectUuid,
                            body,
                        );
                    const poll: PollOptions = {
                        ...(options.signal !== undefined
                            ? { signal: options.signal }
                            : {}),
                        ...(deps.defaultTimeoutMs !== undefined
                            ? { timeoutMs: deps.defaultTimeoutMs }
                            : {}),
                        ...(input.page !== undefined
                            ? { page: input.page }
                            : {}),
                        ...(input.pageSize !== undefined
                            ? { pageSize: input.pageSize }
                            : {}),
                    };
                    return deps.fieldValuesClient.pollQueryToReady(
                        input.projectUuid,
                        executed.queryUuid,
                        poll,
                    );
                },
                (result) => (result as AgentReadyPage).rows.length,
            ) as Promise<AgentReadyPage>,
    };

    const inputSchemas: Record<DiscoveryToolName, z.ZodType<unknown>> = {
        get_explore: getExploreInputSchema,
        get_metric_metadata: getMetricMetadataInputSchema,
        inspect_warehouse_columns: inspectWarehouseColumnsInputSchema,
        list_explores: listExploresInputSchema,
        list_spaces_and_content: listSpacesAndContentInputSchema,
        search_catalog_fields: searchCatalogFieldsInputSchema,
        search_field_values: searchFieldValuesInputSchema,
    };

    const executeTool = async (
        toolName: string,
        rawInput: unknown,
        principal: AgentPrincipal,
        options: AgentToolRuntimeOptions = {},
    ): Promise<unknown> => {
        if (
            !DISCOVERY_TOOL_NAMES.includes(toolName as DiscoveryToolName) ||
            !(toolName in handlers)
        ) {
            throw new AgentToolError(
                'UNKNOWN_TOOL',
                `Tool "${toolName}" is not recognized.`,
            );
        }
        const name = toolName as DiscoveryToolName;
        const parsed = inputSchemas[name].safeParse(rawInput);
        if (!parsed.success) {
            throw new AgentToolError(
                'INVALID_INPUT',
                formatValidationError(parsed.error),
            );
        }
        return handlers[name](parsed.data as never, principal, options);
    };

    return {
        executeTool,
        handlers,
        inputSchemas,
        toolNames: DISCOVERY_TOOL_NAMES,
    };
};
