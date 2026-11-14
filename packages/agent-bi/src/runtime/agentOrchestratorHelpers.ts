import type { CatalogVisibility } from '../catalog/catalogIndexer';
import { escapeUntrusted } from './agentPrompt';

export interface QueryArtifactColumnPreview {
    format: string | null;
    label: string | null;
    type: string | null;
}

export interface QueryArtifactPreview {
    columns: Record<string, QueryArtifactColumnPreview>;
    dimensions: string[];
    metrics: string[];
    rows: Array<Record<string, unknown>>;
}

export interface ArtifactSummary {
    kind: string;
    preview?: QueryArtifactPreview;
    slug?: string;
    tool: string;
    uuid?: string;
}

export const NEEDS_APPROVAL = new Set<string>([
    'run_sql',
    'schedule_chart_delivery',
    'schedule_dashboard_delivery',
    'upsert_chart_as_code',
    'upsert_dashboard_as_code',
    'upsert_sql_chart_as_code',
]);

const MAX_TOOL_TEXT_CHARS = 4000;
const MAX_ARTIFACT_ROWS = 50;
const MAX_ARTIFACT_COLUMNS = 50;
const MAX_ARTIFACT_CELL_CHARS = 256;
const QUERY_TOOLS = new Set([
    'run_compose_pipeline',
    'run_metric_query',
    'run_saved_chart',
    'run_sql',
    'run_underlying_data',
]);

const catalogVisibilityKey = (visibility: CatalogVisibility): string =>
    JSON.stringify({
        explores: [...visibility.allowedExplores].sort(),
        fields: [...(visibility.allowedFieldsByExplore ?? new Map())]
            .map(([explore, fields]) => [explore, [...fields].sort()])
            .sort(([a], [b]) => String(a).localeCompare(String(b))),
    });

export const assertCatalogVisibilityUnchanged = (
    previous: CatalogVisibility | undefined,
    current: CatalogVisibility | undefined,
): void => {
    if (
        previous !== undefined &&
        current !== undefined &&
        catalogVisibilityKey(previous) !== catalogVisibilityKey(current)
    ) {
        throw new Error('Catalog access changed during the turn.');
    }
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

const firstString = (
    record: Record<string, unknown>,
    keys: string[],
): string | undefined => {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value !== '') {
            return value;
        }
    }
    return undefined;
};

const stringArray = (
    record: Record<string, unknown>,
    key: string,
): string[] => {
    const value = record[key];
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
};

const previewCell = (value: unknown): unknown => {
    if (
        value === null ||
        typeof value === 'number' ||
        typeof value === 'boolean'
    ) {
        return value;
    }
    let text: string;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value) ?? String(value);
        } catch {
            text = String(value);
        }
    }
    return text.length > MAX_ARTIFACT_CELL_CHARS
        ? `${text.slice(0, MAX_ARTIFACT_CELL_CHARS)}…`
        : text;
};

const queryPreviewFor = (
    tool: string,
    toolInput: unknown,
    result: Record<string, unknown>,
): QueryArtifactPreview | undefined => {
    if (!QUERY_TOOLS.has(tool)) {
        return undefined;
    }
    const columnsRecord = asRecord(result.columns);
    if (columnsRecord === null || !Array.isArray(result.rows)) {
        return undefined;
    }
    const columns = Object.fromEntries(
        Object.entries(columnsRecord)
            .slice(0, MAX_ARTIFACT_COLUMNS)
            .map(([fieldId, value]) => {
                const column = asRecord(value);
                return [
                    fieldId,
                    {
                        format:
                            column === null
                                ? null
                                : (firstString(column, ['format']) ?? null),
                        label:
                            column === null
                                ? null
                                : (firstString(column, ['label']) ?? null),
                        type:
                            column === null
                                ? null
                                : (firstString(column, ['type']) ?? null),
                    },
                ];
            }),
    );
    const fieldIds = new Set(Object.keys(columns));
    const rows = result.rows.slice(0, MAX_ARTIFACT_ROWS).flatMap((rowValue) => {
        const row = asRecord(rowValue);
        if (row === null) return [];
        return [
            Object.fromEntries(
                Object.entries(row)
                    .filter(([fieldId]) => fieldIds.has(fieldId))
                    .map(([fieldId, cellValue]) => [
                        fieldId,
                        previewCell(cellValue),
                    ]),
            ),
        ];
    });
    const inputRecord = asRecord(toolInput) ?? {};
    return {
        columns,
        dimensions: stringArray(inputRecord, 'dimensions'),
        metrics: stringArray(inputRecord, 'metrics'),
        rows,
    };
};

const artifactKindFor = (tool: string): string => {
    if (tool.includes('dashboard')) {
        return 'dashboard';
    }
    if (tool.includes('chart')) {
        return 'chart';
    }
    if (tool.includes('export') || tool.includes('schedule')) {
        return 'export';
    }
    if (tool.startsWith('run_')) {
        return 'query';
    }
    return 'result';
};

export const toArtifact = (
    tool: string,
    result: unknown,
    toolInput: unknown,
): ArtifactSummary | null => {
    const record = asRecord(result);
    if (record === null) {
        return null;
    }
    const slug = firstString(record, ['slug', 'chartSlug', 'dashboardSlug']);
    const uuid = firstString(record, [
        'uuid',
        'chartUuid',
        'dashboardUuid',
        'queryUuid',
    ]);
    if (slug === undefined && uuid === undefined) {
        return null;
    }
    const preview = queryPreviewFor(tool, toolInput, record);
    return {
        kind: artifactKindFor(tool),
        ...(preview !== undefined ? { preview } : {}),
        ...(slug !== undefined ? { slug } : {}),
        tool,
        ...(uuid !== undefined ? { uuid } : {}),
    };
};

export const toUntrustedToolText = (tool: string, result: unknown): string => {
    const serialized = JSON.stringify(result);
    const clipped =
        serialized.length > MAX_TOOL_TEXT_CHARS
            ? `${serialized.slice(0, MAX_TOOL_TEXT_CHARS)}\n[truncated]`
            : serialized;
    return `<untrusted source="tool:${tool}">\n${escapeUntrusted(clipped)}\n</untrusted>`;
};
