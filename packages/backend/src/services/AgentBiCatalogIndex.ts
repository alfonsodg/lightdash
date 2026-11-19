import {
    syncCatalogIndex,
    type CatalogDimensionInput,
    type CatalogExploreInput,
    type CatalogIndexStore,
    type CatalogMetricInput,
} from '@lightdash/agent-bi';
import { isExploreError, type Explore } from '@lightdash/common';
import type { AgentBiModel } from '../models/AgentBiModel';
import type { ProjectModel } from '../models/ProjectModel/ProjectModel';

const CATALOG_INDEX_TABLE = '"agent_ext"."catalog_index"';

const requireString = (value: unknown, field: string): string => {
    if (typeof value !== 'string') {
        throw new Error(`Invalid ${field} returned from catalog index`);
    }
    return value;
};

const toCatalogExplore = (explore: Explore): CatalogExploreInput => ({
    baseTable: explore.baseTable,
    label: explore.label,
    name: explore.name,
    tags: explore.tags ?? [],
    tables: Object.fromEntries(
        Object.entries(explore.tables ?? {}).map(([tableName, table]) => [
            tableName,
            {
                description: table.description,
                dimensions: Object.fromEntries(
                    Object.entries(table.dimensions ?? {}).map(
                        ([fieldName, dimension]) => {
                            const catalogDimension: CatalogDimensionInput = {
                                description: dimension.description,
                                hidden: dimension.hidden,
                                label: dimension.label,
                                name: fieldName,
                                timeInterval: dimension.timeInterval,
                                type: dimension.type,
                            };
                            return [fieldName, catalogDimension];
                        },
                    ),
                ),
                label: table.label,
                metrics: Object.fromEntries(
                    Object.entries(table.metrics ?? {}).map(
                        ([fieldName, metric]) => {
                            const catalogMetric: CatalogMetricInput = {
                                description: metric.description,
                                hidden: metric.hidden,
                                label: metric.label,
                                name: fieldName,
                                type: metric.type,
                            };
                            return [fieldName, catalogMetric];
                        },
                    ),
                ),
                name: table.name,
            },
        ]),
    ),
});

const createCatalogIndexStore = (
    agentBiModel: AgentBiModel,
    projectUuid: string,
): CatalogIndexStore => ({
    listExisting: async (requestedProjectUuid) => {
        if (requestedProjectUuid !== projectUuid) {
            throw new Error('Catalog index project scope changed during sync');
        }
        const { rows } = await agentBiModel.query(
            `SELECT resource_type AS "resourceType", resource_uuid AS "resourceUuid", content FROM ${CATALOG_INDEX_TABLE} WHERE project_uuid = $1`,
            [projectUuid],
        );
        return rows.map((row) => ({
            content: requireString(row.content, 'content'),
            resourceType: requireString(row.resourceType, 'resource type'),
            resourceUuid: requireString(
                row.resourceUuid,
                'resource identifier',
            ),
        }));
    },
    upsertRows: async (documents) => {
        if (documents.length === 0) return;
        const payload = JSON.stringify(
            documents.map((document) => ({
                content: document.content,
                embedding: document.embedding,
                explore_name: document.exploreName,
                field_kind: document.fieldKind,
                field_name: document.fieldName,
                project_uuid: document.projectUuid,
                resource_type: document.resourceType,
                resource_uuid: document.resourceUuid,
                table_name: document.tableName,
            })),
        );
        await agentBiModel.query(
            `INSERT INTO ${CATALOG_INDEX_TABLE} (project_uuid, resource_type, resource_uuid, content, explore_name, table_name, field_name, field_kind, embedding, document, updated_at)
SELECT item.project_uuid, item.resource_type, item.resource_uuid, item.content, item.explore_name, item.table_name, item.field_name, item.field_kind, item.embedding::text::vector, to_tsvector('simple', item.content), now()
FROM jsonb_to_recordset($1::jsonb) AS item(project_uuid uuid, resource_type text, resource_uuid uuid, content text, explore_name text, table_name text, field_name text, field_kind text, embedding jsonb)
ON CONFLICT (project_uuid, resource_type, resource_uuid) DO UPDATE SET content = EXCLUDED.content, explore_name = EXCLUDED.explore_name, table_name = EXCLUDED.table_name, field_name = EXCLUDED.field_name, field_kind = EXCLUDED.field_kind, embedding = EXCLUDED.embedding, document = EXCLUDED.document, updated_at = EXCLUDED.updated_at`,
            [payload],
        );
    },
    deleteKeys: async (keys) => {
        if (keys.length === 0) return;
        await agentBiModel.query(
            `DELETE FROM ${CATALOG_INDEX_TABLE} AS indexed USING jsonb_to_recordset($2::jsonb) AS requested(resource_type text, resource_uuid uuid) WHERE indexed.project_uuid = $1 AND indexed.resource_type = requested.resource_type AND indexed.resource_uuid = requested.resource_uuid`,
            [
                projectUuid,
                JSON.stringify(
                    keys.map((key) => ({
                        resource_type: key.resourceType,
                        resource_uuid: key.resourceUuid,
                    })),
                ),
            ],
        );
    },
});

export const syncAgentBiCatalogIndex = async ({
    agentBiModel,
    projectModel,
    projectUuid,
}: {
    agentBiModel: AgentBiModel;
    projectModel: Pick<ProjectModel, 'findExploresFromCache'>;
    projectUuid: string;
}): Promise<void> => {
    const cachedExplores = await projectModel.findExploresFromCache(
        projectUuid,
        'uuid',
    );
    const explores = Object.values(cachedExplores).flatMap((explore) =>
        isExploreError(explore) ? [] : [toCatalogExplore(explore)],
    );
    await syncCatalogIndex(
        createCatalogIndexStore(agentBiModel, projectUuid),
        projectUuid,
        explores,
    );
};
