import { createHash } from 'node:crypto';

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

export interface CatalogIndexStore {
    listExisting(projectUuid: string): Promise<CatalogExistingRow[]>;
    upsertRows(rows: CatalogDocument[]): Promise<void>;
    deleteKeys(keys: CatalogIndexKey[]): Promise<void>;
}

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

export function assertProjectUuid(projectUuid: string): void {
    if (!UUID_PATTERN.test(projectUuid)) {
        throw new CatalogIndexError('Invalid project identifier');
    }
}

export function hashContent(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function uuidFromParts(...parts: string[]): string {
    const hex = createHash('sha256')
        .update(parts.join('|'), 'utf8')
        .digest('hex')
        .slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
