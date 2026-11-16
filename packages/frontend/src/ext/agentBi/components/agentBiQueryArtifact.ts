import {
    CartesianSeriesType,
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

export type AgentBiChartViewMode =
    | 'auto'
    | 'bar'
    | 'horizontal_bar'
    | 'line'
    | 'area'
    | 'pie'
    | 'table';

export type AgentBiChartMetadata = {
    denominator?: string;
    showDataLabels?: boolean;
    subtitle?: string;
    title?: string;
    xAxisLabel?: string;
    yAxisLabel?: string;
};

export const deriveChartTitle = (preview: AgentBiQueryPreview): string => {
    const metricLabels = preview.metrics.map(
        (id) => preview.columns[id]?.label ?? id,
    );
    const dimLabels = preview.dimensions.map(
        (id) => preview.columns[id]?.label ?? id,
    );
    if (metricLabels.length > 0 && dimLabels.length > 0) {
        return `${metricLabels.join(', ')} by ${dimLabels.join(', ')}`;
    }
    if (metricLabels.length > 0) {
        return metricLabels.join(', ');
    }
    if (dimLabels.length > 0) {
        return `${dimLabels.join(', ')} breakdown`;
    }
    return 'Query result';
};

const isTemporalDimension = (type: string | null | undefined): boolean => {
    const normalized = toDimensionType(type ?? null);
    return (
        normalized === DimensionType.DATE ||
        normalized === DimensionType.TIMESTAMP
    );
};

const resolveChartViewMode = (
    preview: AgentBiQueryPreview,
    dimensions: string[],
    metrics: string[],
    requested: AgentBiChartViewMode,
): Exclude<AgentBiChartViewMode, 'auto'> => {
    if (requested !== 'auto') {
        return requested;
    }
    if (dimensions.length === 0 || metrics.length === 0) {
        return 'table';
    }
    const primaryDim = preview.columns[dimensions[0]];
    if (isTemporalDimension(primaryDim?.type)) {
        return 'line';
    }
    if (preview.rows.length > 10) {
        return 'horizontal_bar';
    }
    return 'bar';
};

const buildCartesianConfig = (
    xField: string,
    yFields: string[],
    seriesType: CartesianSeriesType,
    options: {
        flipAxes?: boolean;
        showDataLabels: boolean;
        xAxisLabel?: string;
        yAxisLabel?: string;
    },
): ChartConfig => {
    const flipAxes = options.flipAxes ?? false;
    return {
        type: ChartType.CARTESIAN,
        config: {
            layout: { flipAxes, xField, yField: yFields },
            eChartsConfig: {
                legend: { selected: {} },
                ...(options.xAxisLabel
                    ? {
                          xAxis: [
                              {
                                  name: options.xAxisLabel,
                                  nameGap: 28,
                                  nameLocation: 'middle',
                              },
                          ],
                      }
                    : {}),
                ...(options.yAxisLabel
                    ? {
                          yAxis: [
                              {
                                  name: options.yAxisLabel,
                                  nameGap: 42,
                                  nameLocation: 'middle',
                              },
                          ],
                      }
                    : {}),
                series: yFields.map((yField) => ({
                    encode: {
                        xRef: { field: xField },
                        yRef: { field: yField },
                    },
                    label: {
                        position: flipAxes ? 'right' : 'top',
                        show: options.showDataLabels,
                    },
                    ...(seriesType === CartesianSeriesType.LINE ||
                    seriesType === CartesianSeriesType.AREA
                        ? { smooth: true }
                        : {}),
                    type: seriesType,
                })),
            },
        },
    };
};

export const buildAgentBiQueryOutput = (
    preview: AgentBiQueryPreview,
    mode: AgentBiChartViewMode = 'auto',
    metadata: AgentBiChartMetadata = {},
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
    const effectiveMode = resolveChartViewMode(
        preview,
        dimensions,
        metrics,
        mode,
    );
    const xAxisLabel =
        metadata.xAxisLabel ??
        (dimensions[0]
            ? (preview.columns[dimensions[0]]?.label ?? dimensions[0])
            : undefined);
    const yAxisLabel =
        metadata.yAxisLabel ??
        (metrics[0]
            ? (preview.columns[metrics[0]]?.label ?? metrics[0])
            : undefined);
    const showDataLabels = metadata.showDataLabels ?? true;

    if (
        mode === 'auto' &&
        metrics.length > 0 &&
        dimensions.length === 0 &&
        rows.length === 1
    ) {
        chartConfig = {
            type: ChartType.BIG_NUMBER,
            config: {
                label: metadata.title ?? yAxisLabel,
                selectedField: metrics[0],
                showBigNumberLabel: true,
            },
        };
    } else if (
        effectiveMode !== 'table' &&
        dimensions.length > 0 &&
        metrics.length > 0
    ) {
        switch (effectiveMode) {
            case 'line':
                chartConfig = buildCartesianConfig(
                    dimensions[0],
                    metrics,
                    CartesianSeriesType.LINE,
                    { showDataLabels, xAxisLabel, yAxisLabel },
                );
                break;
            case 'area':
                chartConfig = buildCartesianConfig(
                    dimensions[0],
                    metrics,
                    CartesianSeriesType.AREA,
                    { showDataLabels, xAxisLabel, yAxisLabel },
                );
                break;
            case 'horizontal_bar':
                chartConfig = buildCartesianConfig(
                    dimensions[0],
                    metrics,
                    CartesianSeriesType.BAR,
                    { flipAxes: true, showDataLabels, xAxisLabel, yAxisLabel },
                );
                break;
            case 'pie':
                chartConfig = {
                    type: ChartType.PIE,
                    config: {
                        groupFieldIds: [dimensions[0]],
                        isDonut: true,
                        metricId: metrics[0],
                        showPercentage: true,
                        showValue: true,
                        valueLabel: 'outside',
                    },
                };
                break;
            case 'bar':
            default:
                chartConfig = buildCartesianConfig(
                    dimensions[0],
                    metrics,
                    CartesianSeriesType.BAR,
                    { showDataLabels, xAxisLabel, yAxisLabel },
                );
                break;
        }
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
