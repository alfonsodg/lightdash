import {
    ChartType,
    DimensionType,
    FieldType,
    MetricType,
    type ChartConfig,
    type RawResultRow,
} from '@lightdash/common';
import {
    renderChart,
    toResultRows,
    type ChartFields,
    type RenderedChart,
} from '@lightdash/visualization';
import { z } from 'zod';

const queryPreviewSchema = z.object({
    columns: z.record(
        z.string(),
        z.object({
            format: z.string().nullable(),
            label: z.string().nullable(),
            type: z.string().nullable(),
        }),
    ),
    dimensions: z.array(z.string()),
    metrics: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.unknown())),
});

const serializedResultValueSchema = z.object({
    value: z.object({
        formatted: z.string(),
        raw: z.unknown(),
    }),
});

export type AgentBiQueryPreview = z.infer<typeof queryPreviewSchema>;

const rawPreviewValue = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    try {
        const parsed = serializedResultValueSchema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data.value.raw : value;
    } catch {
        return value;
    }
};

export const parseAgentBiQueryPreview = (
    value: unknown,
): AgentBiQueryPreview | null => {
    const parsed = queryPreviewSchema.safeParse(value);
    if (!parsed.success) return null;
    return {
        ...parsed.data,
        rows: parsed.data.rows.map((row) =>
            Object.fromEntries(
                Object.entries(row).map(([fieldId, cell]) => [
                    fieldId,
                    rawPreviewValue(cell),
                ]),
            ),
        ),
    };
};

const toDimensionType = (type: string | null): DimensionType =>
    Object.values(DimensionType).find((candidate) => candidate === type) ??
    DimensionType.STRING;

const toMetricType = (type: string | null): MetricType => {
    switch (toDimensionType(type)) {
        case DimensionType.NUMBER:
            return MetricType.NUMBER;
        case DimensionType.DATE:
            return MetricType.DATE;
        case DimensionType.TIMESTAMP:
            return MetricType.TIMESTAMP;
        case DimensionType.BOOLEAN:
            return MetricType.BOOLEAN;
        case DimensionType.STRING:
            return MetricType.STRING;
        default:
            return MetricType.STRING;
    }
};

export const buildAgentBiQueryOutput = (
    preview: AgentBiQueryPreview,
): RenderedChart => {
    const dimensions = preview.dimensions.filter((fieldId) =>
        Object.hasOwn(preview.columns, fieldId),
    );
    const metrics = preview.metrics.filter((fieldId) =>
        Object.hasOwn(preview.columns, fieldId),
    );
    const metricIds = new Set(metrics);
    const fields: ChartFields = Object.fromEntries(
        Object.entries(preview.columns).map(([fieldId, column]) => [
            fieldId,
            {
                fieldType: metricIds.has(fieldId)
                    ? FieldType.METRIC
                    : FieldType.DIMENSION,
                type: metricIds.has(fieldId)
                    ? toMetricType(column.type)
                    : toDimensionType(column.type),
                label: column.label ?? fieldId,
                ...(column.format !== null ? { format: column.format } : {}),
            },
        ]),
    );
    const rows = toResultRows(preview.rows as RawResultRow[], fields);
    let chartConfig: ChartConfig;
    if (dimensions.length > 0 && metrics.length > 0) {
        chartConfig = {
            type: ChartType.CARTESIAN,
            config: {
                layout: { xField: dimensions[0], yField: metrics },
                eChartsConfig: { legend: { selected: {} } },
            },
        };
    } else if (metrics.length > 0 && rows.length === 1) {
        chartConfig = {
            type: ChartType.BIG_NUMBER,
            config: { selectedField: metrics[0] },
        };
    } else {
        chartConfig = { type: ChartType.TABLE };
    }
    return renderChart(
        {
            chartConfig,
            tableConfig: { columnOrder: Object.keys(fields) },
        },
        {
            fields,
            query: { dimensions, metrics },
            rows,
        },
    );
};
