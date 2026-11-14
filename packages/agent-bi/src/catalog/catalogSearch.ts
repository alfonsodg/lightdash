import {
    AGENT_EXT_SCHEMA,
    AGENT_EXT_TABLES,
    resolveSchemaName,
} from '../db/schema';
import {
    assertProjectUuid,
    type CatalogDocument,
    type CatalogSearchHit,
    type CatalogVisibility,
} from './catalogTypes';

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
