import { z } from 'zod';
import type {
    CatalogSearchHit,
    CatalogVisibility,
} from '../catalog/catalogIndexer';
import type { LightdashV2Client } from '../client/lightdashV2Client';
import {
    agentReadyPageSchema,
    pageSchema,
    pageSizeSchema,
    projectUuidSchema,
    type AgentToolBaseDeps,
} from './agentToolTypes';

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

export interface CatalogFieldSearcher {
    search(
        query: string,
        visibility: CatalogVisibility,
        limit: number,
        projectUuid: string,
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

export interface DiscoveryFetchClientOptions {
    baseUrl: string;
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    headers?: Record<string, string>;
}
