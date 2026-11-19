import {
    assertProjectUuid,
    CatalogIndexError,
    hashContent,
    uuidFromParts,
    type CatalogDimensionInput,
    type CatalogDocument,
    type CatalogExistingRow,
    type CatalogExploreInput,
    type CatalogIndexKey,
    type CatalogIndexStore,
    type CatalogMetricInput,
    type CatalogResourceType,
    type CatalogSyncResult,
    type CatalogTableInput,
} from './catalogTypes';

export {
    CatalogIndexError,
    hashContent,
    uuidFromParts,
    type CatalogDimensionInput,
    type CatalogDocument,
    type CatalogExistingRow,
    type CatalogExploreInput,
    type CatalogIndexKey,
    type CatalogIndexStore,
    type CatalogMetricInput,
    type CatalogResourceType,
    type CatalogSearchHit,
    type CatalogSyncResult,
    type CatalogTableInput,
    type CatalogVisibility,
} from './catalogTypes';
export {
    buildCatalogLexicalSearchStatement,
    filterCatalogHits,
    searchCatalogDocuments,
    type CatalogSearchStatement,
    type SearchCatalogOptions,
} from './catalogSearch';

const MAX_SYNC_EXPLORES = 1000;

const normalizeText = (value: string | null | undefined): string =>
    (value ?? '').trim().replace(/\s+/g, ' ');

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
