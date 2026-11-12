// Semantic catalog indexer (Slice A).
//
// Syncs compiled explore metadata (explores, dimensions, metrics,
// descriptions, time dimensions) into `agent_ext.catalog_index` through an
// injected store, so this package stays driver-free. Retrieval-time
// visibility filtering consumes caller-supplied allow-lists; the indexer
// never fetches permissions itself.

import { createHash } from 'node:crypto';
import {
    AGENT_EXT_SCHEMA,
    AGENT_EXT_TABLES,
    resolveSchemaName,
} from '../db/schema';

export type CatalogResourceType = 'explore' | 'dimension' | 'metric';

export interface CatalogDimensionInput {
    name: string;
    label?: string | null;
    description?: string | null;
    type: string;
    timeInterval?: string | null;
    hidden?: boolean | null;
}

export interface CatalogMetricInput {
    name: string;
    label?: string | null;
    description?: string | null;
    type: string;
    hidden?: boolean | null;
}

export interface CatalogTableInput {
    name: string;
    label?: string | null;
    description?: string | null;
    dimensions: Record<string, CatalogDimensionInput>;
    metrics: Record<string, CatalogMetricInput>;
}

export interface CatalogExploreInput {
    name: string;
    label?: string | null;
    description?: string | null;
    tags?: readonly string[] | null;
    baseTable: string;
    tables: Record<string, CatalogTableInput>;
}

export interface CatalogDocument {
    projectUuid: string;
    resourceType: CatalogResourceType;
    resourceUuid: string;
    exploreName: string;
    tableName: string | null;
    fieldName: string | null;
    fieldKind: 'dimension' | 'metric' | null;
    content: string;
    contentHash: string;
    embedding: readonly number[] | null;
}

export interface CatalogExistingRow {
    resourceType: string;
    resourceUuid: string;
    content: string;
}

export interface CatalogIndexKey {
    resourceType: string;
    resourceUuid: string;
}

// Driver-free store surface; any driver implements these three calls.
export interface CatalogIndexStore {
    listExisting(projectUuid: string): Promise<CatalogExistingRow[]>;
    upsertRows(rows: CatalogDocument[]): Promise<void>;
    deleteKeys(keys: CatalogIndexKey[]): Promise<void>;
}

// Visibility allow-lists supplied by the caller (built from host CASL +
// user-attribute checks). Field keys are `tableName.fieldName`.
export interface CatalogVisibility {
    allowedExplores: ReadonlySet<string>;
    allowedFieldsByExplore?: ReadonlyMap<string, ReadonlySet<string>> | null;
}

export interface CatalogSearchHit {
    document: CatalogDocument;
    score: number;
}

export interface CatalogSyncResult {
    upserted: number;
    removed: number;
    unchanged: number;
}

export class CatalogIndexError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CatalogIndexError';
    }
}

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_SYNC_EXPLORES = 1000;

const normalizeText = (value: string | null | undefined): string =>
    (value ?? '').trim().replace(/\s+/g, ' ');

export function hashContent(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

// Deterministic UUID from stable parts (first 32 hex chars of SHA-256,
// laid out 8-4-4-4-12). Same parts always yield the same resource_uuid.
export function uuidFromParts(...parts: string[]): string {
    const hex = createHash('sha256')
        .update(parts.join('|'), 'utf8')
        .digest('hex')
        .slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function assertProjectUuid(projectUuid: string): void {
    if (!UUID_PATTERN.test(projectUuid)) {
        throw new CatalogIndexError('Invalid project identifier');
    }
}

function buildExploreContent(explore: CatalogExploreInput): string {
    const tables = Object.keys(explore.tables ?? {}).sort();
    const tags = [...(explore.tags ?? [])].sort().join(' ');
    return normalizeText(
        `explore ${explore.name} ${explore.label ?? ''} ${explore.description ?? ''} tags ${tags} tables ${tables.join(' ')}`,
    );
}

function buildDimensionContent(
    exploreName: string,
    table: CatalogTableInput,
    name: string,
    dimension: CatalogDimensionInput,
): string {
    const time = dimension.timeInterval
        ? `time interval ${dimension.timeInterval}`
        : '';
    return normalizeText(
        `dimension ${table.name}.${name} ${dimension.label ?? ''} in explore ${exploreName} table ${table.label ?? table.name} ${dimension.description ?? ''} type ${dimension.type} ${time}`,
    );
}

function buildMetricContent(
    exploreName: string,
    table: CatalogTableInput,
    name: string,
    metric: CatalogMetricInput,
): string {
    return normalizeText(
        `metric ${table.name}.${name} ${metric.label ?? ''} in explore ${exploreName} table ${table.label ?? table.name} ${metric.description ?? ''} type ${metric.type}`,
    );
}

function toDocument(
    projectUuid: string,
    resourceType: CatalogResourceType,
    resourceUuid: string,
    exploreName: string,
    tableName: string | null,
    fieldName: string | null,
    fieldKind: 'dimension' | 'metric' | null,
    content: string,
): CatalogDocument {
    return {
        projectUuid,
        resourceType,
        resourceUuid,
        exploreName,
        tableName,
        fieldName,
        fieldKind,
        content,
        contentHash: hashContent(content),
        embedding: null,
    };
}

function assertExploreShape(explore: CatalogExploreInput): void {
    if (!explore || typeof explore.name !== 'string' || !explore.name.trim()) {
        throw new CatalogIndexError('Explore entries must have a name');
    }
    if (!explore.tables || typeof explore.tables !== 'object') {
        throw new CatalogIndexError(
            `Explore "${explore.name}" must include tables`,
        );
    }
}

// Pure: compiled explores -> deterministic index documents.
export function buildCatalogDocuments(
    projectUuid: string,
    explores: readonly CatalogExploreInput[],
): CatalogDocument[] {
    assertProjectUuid(projectUuid);
    if (!Array.isArray(explores)) {
        throw new CatalogIndexError('Explores must be provided as a list');
    }
    if (explores.length > MAX_SYNC_EXPLORES) {
        throw new CatalogIndexError('Too many explores in one sync batch');
    }
    const documents: CatalogDocument[] = [];
    const seen = new Set<string>();
    const sortedExplores: CatalogExploreInput[] = [...explores].sort(
        (a: CatalogExploreInput, b: CatalogExploreInput) =>
            a.name.localeCompare(b.name),
    );
    for (const explore of sortedExplores) {
        assertExploreShape(explore);
        if (seen.has(explore.name)) {
            throw new CatalogIndexError(
                `Duplicate explore "${explore.name}" in sync batch`,
            );
        }
        seen.add(explore.name);
        const exploreContent = buildExploreContent(explore);
        documents.push(
            toDocument(
                projectUuid,
                'explore',
                uuidFromParts('catalog', projectUuid, 'explore', explore.name),
                explore.name,
                null,
                null,
                null,
                exploreContent,
            ),
        );
        const tableNames: string[] = Object.keys(explore.tables).sort();
        for (const tableName of tableNames) {
            const table: CatalogTableInput = explore.tables[tableName];
            const dimensionNames: string[] = Object.keys(
                table.dimensions ?? {},
            ).sort();
            for (const fieldName of dimensionNames) {
                const dimension: CatalogDimensionInput = (table.dimensions ??
                    {})[fieldName];
                if (!dimension.hidden) {
                    documents.push(
                        toDocument(
                            projectUuid,
                            'dimension',
                            uuidFromParts(
                                'catalog',
                                projectUuid,
                                'dimension',
                                explore.name,
                                table.name,
                                fieldName,
                            ),
                            explore.name,
                            table.name,
                            fieldName,
                            'dimension',
                            buildDimensionContent(
                                explore.name,
                                table,
                                fieldName,
                                dimension,
                            ),
                        ),
                    );
                }
            }
            const metricNames: string[] = Object.keys(
                table.metrics ?? {},
            ).sort();
            for (const fieldName of metricNames) {
                const metric: CatalogMetricInput = (table.metrics ?? {})[
                    fieldName
                ];
                if (!metric.hidden) {
                    documents.push(
                        toDocument(
                            projectUuid,
                            'metric',
                            uuidFromParts(
                                'catalog',
                                projectUuid,
                                'metric',
                                explore.name,
                                table.name,
                                fieldName,
                            ),
                            explore.name,
                            table.name,
                            fieldName,
                            'metric',
                            buildMetricContent(
                                explore.name,
                                table,
                                fieldName,
                                metric,
                            ),
                        ),
                    );
                }
            }
        }
    }
    return documents;
}

export interface CatalogDiff {
    upsert: CatalogDocument[];
    remove: CatalogIndexKey[];
    unchanged: number;
}

// Pure: incremental hash diff of desired documents against stored rows.
export function diffCatalogDocuments(
    existing: readonly CatalogExistingRow[],
    desired: readonly CatalogDocument[],
): CatalogDiff {
    const existingByKey = new Map(
        existing.map((row) => [
            `${row.resourceType}|${row.resourceUuid}`,
            hashContent(row.content),
        ]),
    );
    const desiredKeys = new Set<string>();
    const upsert: CatalogDocument[] = [];
    let unchanged = 0;
    for (const document of desired) {
        const key = `${document.resourceType}|${document.resourceUuid}`;
        desiredKeys.add(key);
        if (existingByKey.get(key) === document.contentHash) {
            unchanged += 1;
        } else {
            upsert.push(document);
        }
    }
    const remove: CatalogIndexKey[] = existing
        .filter(
            (row) =>
                !desiredKeys.has(`${row.resourceType}|${row.resourceUuid}`),
        )
        .map((row) => ({
            resourceType: row.resourceType,
            resourceUuid: row.resourceUuid,
        }));
    return { upsert, remove, unchanged };
}

export interface SyncCatalogOptions {
    embeddingProvider?: (content: string) => Promise<readonly number[] | null>;
}

// Orchestrates a sync: build, diff by content hash, write only the delta.
export async function syncCatalogIndex(
    store: CatalogIndexStore,
    projectUuid: string,
    explores: readonly CatalogExploreInput[],
    options: SyncCatalogOptions = {},
): Promise<CatalogSyncResult> {
    assertProjectUuid(projectUuid);
    const desired = buildCatalogDocuments(projectUuid, explores);
    if (options.embeddingProvider) {
        await Promise.all(
            desired.map(async (document) => {
                const embedding = await options.embeddingProvider?.(
                    document.content,
                );
                const next: CatalogDocument = {
                    ...document,
                    embedding: embedding ?? null,
                };
                Object.assign(document, next);
            }),
        );
    }
    const existing = await store.listExisting(projectUuid);
    const diff = diffCatalogDocuments(existing, desired);
    if (diff.upsert.length > 0) {
        await store.upsertRows(diff.upsert);
    }
    if (diff.remove.length > 0) {
        await store.deleteKeys(diff.remove);
    }
    return {
        upserted: diff.upsert.length,
        removed: diff.remove.length,
        unchanged: diff.unchanged,
    };
}

function isFieldAllowed(
    document: CatalogDocument,
    visibility: CatalogVisibility,
): boolean {
    if (!visibility.allowedExplores.has(document.exploreName)) {
        return false;
    }
    if (
        document.fieldKind === null ||
        !visibility.allowedFieldsByExplore ||
        !visibility.allowedFieldsByExplore.has(document.exploreName)
    ) {
        return true;
    }
    const allowed = visibility.allowedFieldsByExplore.get(document.exploreName);
    if (
        !allowed ||
        document.tableName === null ||
        document.fieldName === null
    ) {
        return false;
    }
    return allowed.has(`${document.tableName}.${document.fieldName}`);
}

// Retrieval-time gate: drops hits the active principal may not see.
export function filterCatalogHits(
    hits: readonly CatalogSearchHit[],
    visibility: CatalogVisibility,
): CatalogSearchHit[] {
    return hits.filter((hit) => isFieldAllowed(hit.document, visibility));
}

const tokenize = (value: string): string[] =>
    value
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((token) => token.length > 0);

export interface SearchCatalogOptions {
    limit?: number;
}

// In-memory lexical search over index documents with retrieval-time
// visibility filtering. Name matches outrank description matches.
export function searchCatalogDocuments(
    documents: readonly CatalogDocument[],
    query: string,
    visibility: CatalogVisibility,
    options: SearchCatalogOptions = {},
): CatalogSearchHit[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
        return [];
    }
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const scored: CatalogSearchHit[] = [];
    for (const document of documents) {
        if (isFieldAllowed(document, visibility)) {
            const nameTokens = new Set(
                tokenize(
                    `${document.exploreName} ${document.tableName ?? ''} ${document.fieldName ?? ''}`,
                ),
            );
            const contentTokens = tokenize(document.content);
            const contentCounts = new Map<string, number>();
            for (const token of contentTokens) {
                contentCounts.set(token, (contentCounts.get(token) ?? 0) + 1);
            }
            let score = 0;
            for (const token of tokens) {
                if (nameTokens.has(token)) {
                    score += 3;
                }
                score += Math.min(contentCounts.get(token) ?? 0, 3);
            }
            if (score > 0) {
                scored.push({ document, score });
            }
        }
    }
    scored.sort(
        (a, b) =>
            b.score - a.score ||
            a.document.resourceType.localeCompare(b.document.resourceType) ||
            a.document.resourceUuid.localeCompare(b.document.resourceUuid),
    );
    return scored.slice(0, limit);
}

export interface CatalogSearchStatement {
    text: string;
    params: [string, string, number];
}

// Lexical search statement for live PG retrieval; callers still filter
// returned hits through `filterCatalogHits` before serving them.
export function buildCatalogLexicalSearchStatement(
    projectUuid: string,
    query: string,
    limit: number,
    schema: string = AGENT_EXT_SCHEMA,
): CatalogSearchStatement {
    assertProjectUuid(projectUuid);
    const table = AGENT_EXT_TABLES.catalogIndex;
    const resolved = resolveSchemaName(schema);
    const bounded = Math.min(Math.max(Math.floor(limit), 1), 100);
    return {
        text: `SELECT project_uuid, resource_type, resource_uuid, content FROM "${resolved}"."${table}" WHERE project_uuid = $1 AND document @@ plainto_tsquery('english', $2) ORDER BY ts_rank(document, plainto_tsquery('english', $2)) DESC LIMIT $3`,
        params: [projectUuid, query, bounded],
    };
}
