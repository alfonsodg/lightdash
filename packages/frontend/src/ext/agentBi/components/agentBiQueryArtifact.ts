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
import { getAgentBiString, type AgentBiLocale } from '../i18n/agentBiLocale';

export type AgentBiQueryColumn = {
    format: string | null;
    label: string | null;
    type: string | null;
};

export type AgentBiQueryPreview = {
    columns: Record<string, AgentBiQueryColumn>;
    dimensions: string[];
    metrics: string[];
    rows: Array<Record<string, unknown>>;
};

export type AgentBiPaletteKey =
    | 'corporate'
    | 'emerald'
    | 'ocean'
    | 'sunset'
    | 'contrast';

export const AGENT_BI_PALETTES: Record<AgentBiPaletteKey, string[]> = {
    contrast: [
        '#1D4ED8',
        '#DC2626',
        '#16A34A',
        '#D97706',
        '#7C3AED',
        '#0891B2',
        '#DB2777',
        '#374151',
    ],
    corporate: [
        '#2563EB',
        '#06B6D4',
        '#10B981',
        '#F59E0B',
        '#EC4899',
        '#8B5CF6',
        '#14B8A6',
        '#F97316',
    ],
    emerald: [
        '#059669',
        '#10B981',
        '#0D9488',
        '#34D399',
        '#2563EB',
        '#F59E0B',
        '#6366F1',
        '#84CC16',
    ],
    ocean: [
        '#1E40AF',
        '#0284C7',
        '#0891B2',
        '#2DD4BF',
        '#4F46E5',
        '#38BDF8',
        '#0F766E',
        '#818CF8',
    ],
    sunset: [
        '#EA580C',
        '#F59E0B',
        '#E11D48',
        '#8B5CF6',
        '#EC4899',
        '#14B8A6',
        '#F97316',
        '#6366F1',
    ],
};

const rawPreviewValue = (cell: unknown): unknown => {
    let candidate = cell;
    if (typeof candidate === 'string' && candidate.startsWith('{')) {
        try {
            candidate = JSON.parse(candidate) as unknown;
        } catch {
            return cell;
        }
    }
    if (
        typeof candidate === 'object' &&
        candidate !== null &&
        'value' in candidate &&
        typeof (candidate as { value: unknown }).value === 'object' &&
        (candidate as { value: unknown }).value !== null &&
        'raw' in ((candidate as { value: Record<string, unknown> }).value ?? {})
    ) {
        return (candidate as { value: { raw: unknown } }).value.raw;
    }
    return cell;
};

export const parseAgentBiQueryPreview = (
    value: unknown,
): AgentBiQueryPreview | null => {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const candidate = value as Record<string, unknown>;
    if (
        typeof candidate.columns !== 'object' ||
        candidate.columns === null ||
        !Array.isArray(candidate.dimensions) ||
        !Array.isArray(candidate.metrics) ||
        !Array.isArray(candidate.rows)
    ) {
        return null;
    }
    return {
        columns: candidate.columns as Record<string, AgentBiQueryColumn>,
        dimensions: candidate.dimensions.filter(
            (item): item is string => typeof item === 'string',
        ),
        metrics: candidate.metrics.filter(
            (item): item is string => typeof item === 'string',
        ),
        rows: candidate.rows.map((row) =>
            Object.fromEntries(
                Object.entries(row as Record<string, unknown>).map(
                    ([fieldId, cell]) => [fieldId, rawPreviewValue(cell)],
                ),
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
    | 'donut'
    | 'funnel'
    | 'radar'
    | 'treemap'
    | 'scatter'
    | 'bar_3d'
    | 'table';

export type AgentBiChartMetadata = {
    denominator?: string;
    paletteName?: AgentBiPaletteKey;
    showDataLabels?: boolean;
    showTableBelow?: boolean;
    subtitle?: string;
    title?: string;
    xAxisLabel?: string;
    yAxisLabel?: string;
};

export const deriveChartTitle = (
    preview: AgentBiQueryPreview,
    locale: AgentBiLocale = 'es',
): string => {
    const metricLabels = preview.metrics.map(
        (id) => preview.columns[id]?.label ?? id,
    );
    const dimLabels = preview.dimensions.map(
        (id) => preview.columns[id]?.label ?? id,
    );
    if (metricLabels.length > 0 && dimLabels.length > 0) {
        const connector = getAgentBiString(locale, 'chart.titleConnector');
        return `${metricLabels.join(', ')} ${connector} ${dimLabels.join(', ')}`;
    }
    if (metricLabels.length > 0) {
        return metricLabels.join(', ');
    }
    if (dimLabels.length > 0) {
        const prefix = getAgentBiString(locale, 'chart.breakdownPrefix');
        return `${prefix} ${dimLabels.join(', ')}`;
    }
    return getAgentBiString(locale, 'chart.defaultTitle');
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

const numericValue = (val: unknown): number => {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string') {
        const n = Number(val);
        if (Number.isFinite(n)) return n;
    }
    return 0;
};

const categoryLabel = (val: unknown): string =>
    val === null || val === undefined || val === '' ? '—' : String(val);

const buildCustomEchartsOutput = (
    mode: 'funnel' | 'radar' | 'treemap' | 'bar_3d',
    preview: AgentBiQueryPreview,
    dimField: string,
    metricFields: string[],
    palette: string[],
    options: {
        showDataLabels: boolean;
        xAxisLabel?: string;
        yAxisLabel?: string;
    },
): RenderedChart => {
    const primaryMetric = metricFields[0];
    const items = preview.rows.slice(0, 20).map((row, idx) => ({
        color: palette[idx % palette.length],
        name: categoryLabel(row[dimField]),
        value: numericValue(row[primaryMetric]),
    }));

    if (mode === 'funnel') {
        return {
            chartType: ChartType.FUNNEL,
            colorAssignments: {},
            kind: 'echarts',
            option: {
                color: palette,
                tooltip: { trigger: 'item' },
                legend: { bottom: 0, type: 'scroll' },
                series: [
                    {
                        data: [...items]
                            .sort((a, b) => b.value - a.value)
                            .map((item) => ({
                                name: item.name,
                                value: item.value,
                            })),
                        gap: 3,
                        itemStyle: {
                            borderColor: '#ffffff',
                            borderWidth: 1,
                            shadowBlur: 8,
                            shadowColor: 'rgba(15, 23, 42, 0.12)',
                        },
                        label: {
                            position: 'inside',
                            show: options.showDataLabels,
                        },
                        left: '10%',
                        top: 16,
                        bottom: 40,
                        type: 'funnel',
                        width: '80%',
                    },
                ],
            },
        };
    }

    if (mode === 'treemap') {
        return {
            chartType: ChartType.TREEMAP,
            colorAssignments: {},
            kind: 'echarts',
            option: {
                color: palette,
                tooltip: { trigger: 'item' },
                series: [
                    {
                        breadcrumb: { show: false },
                        data: items.map((item, idx) => ({
                            itemStyle: { color: palette[idx % palette.length] },
                            name: item.name,
                            value: item.value,
                        })),
                        itemStyle: {
                            borderColor: '#ffffff',
                            borderRadius: 6,
                            borderWidth: 2,
                            gapWidth: 2,
                        },
                        label: {
                            formatter: options.showDataLabels
                                ? '{b}\n{c}'
                                : '{b}',
                            show: true,
                        },
                        roam: false,
                        type: 'treemap',
                    },
                ],
            },
        };
    }

    if (mode === 'radar') {
        const categories = preview.rows.slice(0, 8);
        const indicators =
            metricFields.length >= 3
                ? metricFields.map((mId) => {
                      const maxVal = Math.max(
                          1,
                          ...categories.map((r) => numericValue(r[mId])),
                      );
                      return {
                          max: Math.ceil(maxVal * 1.15),
                          name: preview.columns[mId]?.label ?? mId,
                      };
                  })
                : categories.map((r) => ({
                      max: Math.ceil(
                          Math.max(1, numericValue(r[primaryMetric])) * 1.15,
                      ),
                      name: categoryLabel(r[dimField]),
                  }));

        const seriesData =
            metricFields.length >= 3
                ? categories.map((r) => ({
                      name: categoryLabel(r[dimField]),
                      value: metricFields.map((mId) => numericValue(r[mId])),
                  }))
                : metricFields.map((mId) => ({
                      name: preview.columns[mId]?.label ?? mId,
                      value: categories.map((r) => numericValue(r[mId])),
                  }));

        return {
            chartType: ChartType.CARTESIAN,
            colorAssignments: {},
            kind: 'echarts',
            option: {
                color: palette,
                legend: { bottom: 0, type: 'scroll' },
                radar: {
                    indicator: indicators,
                    radius: '62%',
                },
                series: [
                    {
                        areaStyle: { opacity: 0.18 },
                        data: seriesData,
                        type: 'radar',
                    },
                ],
                tooltip: { trigger: 'item' },
            },
        };
    }

    // bar_3d: Isometric 3D prism bars using native ECharts bar + diamond top cap
    const categories = items.map((i) => i.name);
    const values = items.map((i) => i.value);
    return {
        chartType: ChartType.CARTESIAN,
        colorAssignments: {},
        kind: 'echarts',
        option: {
            color: palette,
            grid: {
                bottom: 48,
                containLabel: true,
                left: 20,
                right: 20,
                top: 28,
            },
            tooltip: { trigger: 'axis' },
            xAxis: {
                axisTick: { show: false },
                data: categories,
                name: options.xAxisLabel,
                nameGap: 26,
                nameLocation: 'middle',
                type: 'category',
            },
            yAxis: {
                name: options.yAxisLabel,
                splitLine: { lineStyle: { type: 'dashed' } },
                type: 'value',
            },
            series: [
                {
                    barWidth: 26,
                    data: values.map((v, idx) => ({
                        itemStyle: {
                            borderRadius: [2, 2, 0, 0],
                            color: {
                                colorStops: [
                                    {
                                        color: palette[idx % palette.length],
                                        offset: 0,
                                    },
                                    { color: '#1E293B', offset: 1 },
                                ],
                                type: 'linear',
                                x: 0,
                                x2: 0,
                                y: 0,
                                y2: 1,
                            },
                            shadowBlur: 12,
                            shadowColor: 'rgba(30, 64, 175, 0.25)',
                            shadowOffsetX: 6,
                            shadowOffsetY: 4,
                        },
                        value: v,
                    })),
                    label: {
                        position: 'top',
                        show: options.showDataLabels,
                    },
                    name:
                        preview.columns[primaryMetric]?.label ?? primaryMetric,
                    type: 'bar',
                },
                {
                    data: values.map((v, idx) => ({
                        itemStyle: { color: palette[idx % palette.length] },
                        value: v,
                    })),
                    symbol: 'diamond',
                    symbolOffset: [0, '-50%'],
                    symbolPosition: 'end',
                    symbolSize: [26, 10],
                    tooltip: { show: false },
                    type: 'pictorialBar',
                    z: 12,
                },
            ],
        },
    };
};

const buildCartesianConfig = (
    xField: string,
    yFields: string[],
    seriesType: CartesianSeriesType,
    palette: string[],
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
                          xAxis: [{ name: options.xAxisLabel }],
                      }
                    : {}),
                ...(options.yAxisLabel
                    ? {
                          yAxis: [{ name: options.yAxisLabel }],
                      }
                    : {}),
                series: yFields.map((yField, index) => ({
                    color: palette[index % palette.length],
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
    const palette =
        AGENT_BI_PALETTES[metadata.paletteName ?? 'corporate'] ??
        AGENT_BI_PALETTES.corporate;
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
        (effectiveMode === 'funnel' ||
            effectiveMode === 'radar' ||
            effectiveMode === 'treemap' ||
            effectiveMode === 'bar_3d') &&
        dimensions.length > 0 &&
        metrics.length > 0
    ) {
        return buildCustomEchartsOutput(
            effectiveMode,
            preview,
            dimensions[0],
            metrics,
            palette,
            { showDataLabels, xAxisLabel, yAxisLabel },
        );
    }

    let chartConfig: ChartConfig;
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
                    palette,
                    { showDataLabels, xAxisLabel, yAxisLabel },
                );
                break;
            case 'area':
                chartConfig = buildCartesianConfig(
                    dimensions[0],
                    metrics,
                    CartesianSeriesType.AREA,
                    palette,
                    { showDataLabels, xAxisLabel, yAxisLabel },
                );
                break;
            case 'scatter':
                chartConfig = buildCartesianConfig(
                    dimensions[0],
                    metrics,
                    CartesianSeriesType.SCATTER,
                    palette,
                    { showDataLabels, xAxisLabel, yAxisLabel },
                );
                break;
            case 'horizontal_bar':
                chartConfig = buildCartesianConfig(
                    dimensions[0],
                    metrics,
                    CartesianSeriesType.BAR,
                    palette,
                    { flipAxes: true, showDataLabels, xAxisLabel, yAxisLabel },
                );
                break;
            case 'pie':
                chartConfig = {
                    type: ChartType.PIE,
                    config: {
                        groupFieldIds: [dimensions[0]],
                        isDonut: false,
                        metricId: metrics[0],
                        showPercentage: true,
                        showValue: true,
                        valueLabel: 'outside',
                    },
                };
                break;
            case 'donut':
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
                    palette,
                    { showDataLabels, xAxisLabel, yAxisLabel },
                );
                break;
        }
    } else {
        chartConfig = { type: ChartType.TABLE };
    }

    const rendered = renderChart(
        {
            chartConfig,
            tableConfig: { columnOrder: Object.keys(fields) },
        },
        {
            fields,
            query: { dimensions, metrics },
            rows,
        },
        { colors: { palette } },
    );
    if (rendered.kind === 'echarts') {
        return {
            ...rendered,
            option: {
                ...rendered.option,
                color: palette,
            },
        };
    }
    return rendered;
};

export const exportPreviewToCsv = (preview: AgentBiQueryPreview): string => {
    const columnIds = Object.keys(preview.columns);
    const escapeCell = (val: unknown): string => {
        const str = val === null || val === undefined ? '' : String(val);
        return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const header = columnIds
        .map((id) => escapeCell(preview.columns[id]?.label ?? id))
        .join(',');
    const body = preview.rows.map((row) =>
        columnIds.map((id) => escapeCell(row[id])).join(','),
    );
    return `\uFEFF${[header, ...body].join('\n')}`;
};
