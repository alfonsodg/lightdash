import { describe, expect, it } from 'vitest';
import {
    buildAgentBiQueryOutput,
    parseAgentBiQueryPreview,
} from './agentBiQueryArtifact';

const preview = {
    columns: {
        orders_count: { format: null, label: 'Orders', type: 'number' },
        orders_status: { format: null, label: 'Status', type: 'string' },
    },
    dimensions: ['orders_status'],
    metrics: ['orders_count'],
    rows: [
        { orders_count: 3, orders_status: 'complete' },
        { orders_count: 2, orders_status: 'pending' },
    ],
};

describe('agent BI query artifacts', () => {
    it('parses bounded query data for a visualization', () => {
        expect(parseAgentBiQueryPreview({ extra: true, ...preview })).toEqual(
            preview,
        );
        expect(parseAgentBiQueryPreview({ rows: 'invalid' })).toBeNull();
    });

    it('unwraps query result cells and defaults time chart legend selection', () => {
        const parsed = parseAgentBiQueryPreview({
            columns: {
                order_month: {
                    format: null,
                    label: 'Order Month',
                    type: 'timestamp',
                },
                order_count: {
                    format: null,
                    label: 'Order Count',
                    type: 'number',
                },
            },
            dimensions: ['order_month'],
            metrics: ['order_count'],
            rows: [
                {
                    order_count: '{"value":{"raw":"3","formatted":"3"}}',
                    order_month:
                        '{"value":{"raw":"2026-03-01","formatted":"2026-03"}}',
                },
            ],
        });

        expect(parsed?.rows).toEqual([
            { order_count: '3', order_month: '2026-03-01' },
        ]);
        if (parsed !== null) {
            const output = buildAgentBiQueryOutput(parsed);
            expect(output.kind).toBe('echarts');
            if (output.kind === 'echarts') {
                expect(output.option.legend).toMatchObject({ selected: {} });
            }
        }
    });

    it('renders dimensions and metrics as a chart', () => {
        const output = buildAgentBiQueryOutput(preview);
        expect(output.kind).toBe('echarts');
        if (output.kind === 'echarts') {
            expect(output.option.legend).toMatchObject({ selected: {} });
        }
    });

    it('renders one metric as a KPI', () => {
        const output = buildAgentBiQueryOutput({
            ...preview,
            dimensions: [],
            metrics: ['orders_count'],
            rows: [{ orders_count: 3 }],
        });
        expect(output.kind).toBe('bigNumber');
        if (output.kind === 'bigNumber') {
            expect(output.model.value).toBe('3');
        }
    });

    it('uses a table when the query has no chartable metric', () => {
        expect(
            buildAgentBiQueryOutput({
                ...preview,
                dimensions: ['orders_status'],
                metrics: [],
            }).kind,
        ).toBe('table');
    });
});
