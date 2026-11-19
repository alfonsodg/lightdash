import { z } from 'zod';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import type {
    PollOptions,
    V2FieldValueSearchBody,
} from '../client/lightdashV2Client';
import {
    AgentToolError,
    formatValidationError,
    type AgentReadyPage,
    type AgentToolRuntimeOptions,
} from './agentToolTypes';
import {
    buildExplorePath,
    buildExploresPath,
    buildMetricMetadataPath,
    buildWarehouseFieldsPath,
    CONTENT_LIST_PATH,
    runGuardedDiscovery,
    toCatalogHits,
    toContentItems,
    toExploreDetail,
    toExploreSummaries,
    toWarehouseColumns,
    unwrapResults,
    type InvokeFn,
} from './discoveryHelpers';
import {
    DISCOVERY_TOOL_NAMES,
    getExploreInputSchema,
    getExploreOutputSchema,
    getMetricMetadataInputSchema,
    getMetricMetadataOutputSchema,
    inspectWarehouseColumnsInputSchema,
    inspectWarehouseColumnsOutputSchema,
    listExploresInputSchema,
    listExploresOutputSchema,
    listSpacesAndContentInputSchema,
    listSpacesAndContentOutputSchema,
    searchCatalogFieldsInputSchema,
    searchCatalogFieldsOutputSchema,
    searchFieldValuesInputSchema,
    searchFieldValuesOutputSchema,
    type DiscoveryToolDeps,
    type DiscoveryToolName,
    type GetExploreInput,
    type GetMetricMetadataInput,
    type InspectWarehouseColumnsInput,
    type ListExploresInput,
    type ListSpacesAndContentInput,
    type SearchCatalogFieldsInput,
    type SearchFieldValuesInput,
} from './discoverySchemas';

export { AgentToolError } from './agentToolTypes';
export {
    CONTENT_LIST_PATH,
    buildExplorePath,
    buildExploresPath,
    buildMetricMetadataPath,
    buildWarehouseFieldsPath,
    createDiscoveryFetchClient,
} from './discoveryHelpers';
export {
    DISCOVER_CAPABILITY,
    DISCOVERY_TOOL_NAMES,
    getExploreInputSchema,
    getExploreOutputSchema,
    getMetricMetadataInputSchema,
    getMetricMetadataOutputSchema,
    inspectWarehouseColumnsInputSchema,
    inspectWarehouseColumnsOutputSchema,
    listExploresInputSchema,
    listExploresOutputSchema,
    listSpacesAndContentInputSchema,
    listSpacesAndContentOutputSchema,
    searchCatalogFieldsInputSchema,
    searchCatalogFieldsOutputSchema,
    searchFieldValuesInputSchema,
    searchFieldValuesOutputSchema,
    type CatalogFieldSearcher,
    type DiscoveryFetch,
    type DiscoveryFetchClientOptions,
    type DiscoveryFetchRequest,
    type DiscoveryToolDeps,
    type DiscoveryToolName,
    type FieldValuesClient,
    type GetExploreInput,
    type GetMetricMetadataInput,
    type InspectWarehouseColumnsInput,
    type ListExploresInput,
    type ListSpacesAndContentInput,
    type SearchCatalogFieldsInput,
    type SearchFieldValuesInput,
} from './discoverySchemas';

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
                        input.projectUuid,
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
