// Slice 1 (TDD red): AgentBiChartRenderer covers all 6 RenderOutput kinds
// from @lightdash/visualization via Mantine v9 surfaces.
import { ChartType } from '@lightdash/common';
import type { RenderedChart } from '@lightdash/visualization';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../testing/testUtils';

vi.mock('../../../components/EChartsReactWrapper', () => ({
    default: () => <div data-testid="echarts-mock" />,
}));

vi.mock('react-vega', () => ({
    VegaEmbed: () => <div data-testid="vega-mock" />,
}));

import AgentBiChartRenderer from './AgentBiChartRenderer';

const rendered = (output: RenderedChart['kind']): RenderedChart => {
    const base = { colorAssignments: {} };
    switch (output) {
        case 'echarts':
            return {
                ...base,
                chartType: ChartType.CARTESIAN,
                kind: 'echarts',
                option: { series: [] },
            } as unknown as RenderedChart;
        case 'table':
            return {
                ...base,
                chartType: ChartType.TABLE,
                kind: 'table',
                model: {
                    columns: [
                        {
                            frozen: false,
                            header: {},
                            id: 'orders',
                            imageWidth: undefined,
                            isVisible: true,
                            item: undefined,
                            labelOverride: undefined,
                            total: {},
                            width: undefined,
                        },
                    ],
                    groupedSubtotals: undefined,
                    pivotData: undefined,
                    rows: [{ orders: { value: 42 } }],
                    totals: undefined,
                },
            } as unknown as RenderedChart;
        case 'bigNumber':
            return {
                ...base,
                chartType: ChartType.BIG_NUMBER,
                kind: 'bigNumber',
                model: {
                    comparison: {
                        direction: 'up',
                        formattedValue: '12%',
                        label: 'vs prior',
                        tooltip: 'up 12%',
                    },
                    defaultLabel: 'Orders',
                    flipColors: false,
                    granularityFields: [],
                    item: undefined,
                    label: 'Orders',
                    resolvedLabel: 'Orders',
                    showComparison: false,
                    showLabel: true,
                    showStyle: false,
                    value: '42',
                    valueColor: undefined,
                },
            } as unknown as RenderedChart;
        case 'custom':
            return {
                ...base,
                chartType: ChartType.CUSTOM,
                data: [],
                kind: 'custom',
                spec: { mark: 'point' },
            } as unknown as RenderedChart;
        case 'empty':
            return {
                ...base,
                chartType: ChartType.CARTESIAN,
                kind: 'empty',
                reason: 'noRows',
            } as unknown as RenderedChart;
        case 'unsupported':
            return {
                ...base,
                chartType: ChartType.MAP,
                kind: 'unsupported',
            } as unknown as RenderedChart;
        default:
            return {
                ...base,
                chartType: ChartType.CARTESIAN,
                kind: 'empty',
                reason: 'noRows',
            } as unknown as RenderedChart;
    }
};

describe('AgentBiChartRenderer', () => {
    it('renders echarts output', () => {
        renderWithProviders(
            <AgentBiChartRenderer output={rendered('echarts')} />,
        );
        expect(screen.getByTestId('echarts-mock')).toBeInTheDocument();
    });

    it('renders table output with rows', () => {
        renderWithProviders(
            <AgentBiChartRenderer output={rendered('table')} />,
        );
        expect(screen.getByText('42')).toBeInTheDocument();
    });

    it('renders bigNumber output value and label', () => {
        renderWithProviders(
            <AgentBiChartRenderer
                output={rendered('bigNumber')}
                title="Revenue"
            />,
        );
        expect(screen.getByText('42')).toBeInTheDocument();
        expect(screen.getByText('Orders')).toBeInTheDocument();
    });

    it('renders custom Vega output', async () => {
        renderWithProviders(
            <AgentBiChartRenderer output={rendered('custom')} />,
        );
        expect(await screen.findByTestId('vega-mock')).toBeInTheDocument();
    });

    it('renders empty state for no rows', () => {
        renderWithProviders(
            <AgentBiChartRenderer output={rendered('empty')} />,
        );
        expect(screen.getByText(/no data/i)).toBeInTheDocument();
    });

    it('renders deep-link fallback for unsupported maps', () => {
        renderWithProviders(
            <AgentBiChartRenderer
                href="/projects/p/charts/metrics"
                output={rendered('unsupported')}
            />,
        );
        expect(screen.getByText(/open chart/i)).toBeInTheDocument();
    });
});
