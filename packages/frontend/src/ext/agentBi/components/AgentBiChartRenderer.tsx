import { assertUnreachable, type ResultRow } from '@lightdash/common';
import type { RenderedChart } from '@lightdash/visualization';
import { Anchor, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { useComputedColorScheme } from '@mantine/core';
import { IconArrowUpRight } from '@tabler/icons-react';
import { lazy, Suspense, type ReactElement } from 'react';
import EChartsReact from '../../../components/EChartsReactWrapper';
import classes from './AgentBiChartRenderer.module.css';

const VegaEmbed = lazy(() =>
    import('react-vega').then((module) => ({ default: module.VegaEmbed })),
);

const CHART_HEIGHT = 320;

const cellText = (value: unknown): string => {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number') {
        return String(value);
    }
    if (value === null || value === undefined) {
        return '—';
    }
    return String(value);
};

const rowCell = (row: ResultRow, columnId: string): string => {
    const cell = row[columnId];
    if (cell === undefined) {
        return '—';
    }
    return cellText((cell as { value: unknown }).value);
};

const EchartsBody = ({
    output,
}: {
    output: Extract<RenderedChart, { kind: 'echarts' }>;
}): ReactElement => (
    <EChartsReact option={output.option} className={classes.chart} />
);

const TableBody = ({
    output,
}: {
    output: Extract<RenderedChart, { kind: 'table' }>;
}): ReactElement => {
    const { model } = output;
    const visible = model.columns.filter((column) => column.isVisible);
    return (
        <Table.ScrollContainer minWidth={700}>
            <Table>
                <Table.Thead>
                    <Table.Tr>
                        {visible.map((column) => (
                            <Table.Th key={column.id}>
                                {column.labelOverride ??
                                    (column.item && 'label' in column.item
                                        ? column.item.label
                                        : undefined) ??
                                    column.id}
                            </Table.Th>
                        ))}
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {model.rows.slice(0, 50).map((row, index) => (
                        <Table.Tr key={index}>
                            {visible.map((column) => (
                                <Table.Td key={column.id}>
                                    {rowCell(row, column.id)}
                                </Table.Td>
                            ))}
                        </Table.Tr>
                    ))}
                </Table.Tbody>
            </Table>
        </Table.ScrollContainer>
    );
};

const BigNumberBody = ({
    output,
}: {
    output: Extract<RenderedChart, { kind: 'bigNumber' }>;
}): ReactElement => {
    const { model } = output;
    return (
        <Stack gap="xs" align="center" className={classes.kpi}>
            <Title order={3} ta="center">
                {model.value ?? '—'}
            </Title>
            {model.showLabel && model.label ? (
                <Text c="dimmed" ta="center">
                    {model.label}
                </Text>
            ) : null}
        </Stack>
    );
};

const CustomBody = ({
    output,
}: {
    output: Extract<RenderedChart, { kind: 'custom' }>;
}): ReactElement => {
    const isDark = useComputedColorScheme('light') === 'dark';
    return (
        <Suspense fallback={<Text c="dimmed">Loading chart…</Text>}>
            <VegaEmbed
                // @ts-ignore: Vega-Lite spec union types mismatch, same as CustomVisualization
                spec={{
                    ...output.spec,
                    background: isDark ? '#1a1b1e' : 'transparent',
                    data: { values: output.data.series },
                    height: CHART_HEIGHT,
                }}
                options={{ actions: false, ast: true }}
            />
        </Suspense>
    );
};

const EmptyBody = ({
    output,
}: {
    output: Extract<RenderedChart, { kind: 'empty' }>;
}): ReactElement => {
    const label =
        output.reason === 'noRows'
            ? 'No data for this query.'
            : 'This view is not available.';
    return (
        <Paper variant="dotted" p="md">
            <Text c="dimmed" ta="center">
                {label}
            </Text>
        </Paper>
    );
};

const UnsupportedBody = ({ href }: { href?: string }): ReactElement => {
    if (href === undefined) {
        return (
            <Paper variant="dotted" p="md">
                <Text c="dimmed" ta="center">
                    This chart type is not previewed here.
                </Text>
            </Paper>
        );
    }
    return (
        <Paper variant="dotted" p="md">
            <Anchor href={href} c="dimmed" aria-label="Open chart">
                <Text c="dimmed" ta="center" fz="sm">
                    Open chart <IconArrowUpRight size={14} aria-hidden />
                </Text>
            </Anchor>
        </Paper>
    );
};

type Props = {
    href?: string;
    output: RenderedChart;
    title?: string;
};

const AgentBiChartRenderer = ({ href, output, title }: Props): ReactElement => {
    let body: ReactElement;
    switch (output.kind) {
        case 'echarts':
            body = <EchartsBody output={output} />;
            break;
        case 'table':
            body = <TableBody output={output} />;
            break;
        case 'bigNumber':
            body = <BigNumberBody output={output} />;
            break;
        case 'custom':
            body = <CustomBody output={output} />;
            break;
        case 'empty':
            body = <EmptyBody output={output} />;
            break;
        case 'unsupported':
            body = <UnsupportedBody href={href} />;
            break;
        default:
            body = assertUnreachable(output, 'Unknown render output');
    }
    return (
        <Paper p="md" className={classes.root}>
            {title !== undefined ? (
                <Title order={5} className={classes.title}>
                    {title}
                </Title>
            ) : null}
            {body}
        </Paper>
    );
};

export default AgentBiChartRenderer;
