import { assertUnreachable, type ResultRow } from '@lightdash/common';
import type { RenderedChart } from '@lightdash/visualization';
import { Anchor, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { useComputedColorScheme } from '@mantine/core';
import { IconArrowUpRight } from '@tabler/icons-react';
import { lazy, Suspense, type ReactElement } from 'react';
import EChartsReact from '../../../components/EChartsReactWrapper';
import { useAgentBiLocale } from '../i18n/agentBiLocale';
import classes from './AgentBiChartRenderer.module.css';

const VegaEmbed = lazy(() =>
    import('react-vega').then((module) => ({ default: module.VegaEmbed })),
);

const CHART_HEIGHT = 320;

const cellText = (value: unknown): string => {
    if (typeof value === 'string') {
        try {
            const parsed: unknown = JSON.parse(value);
            if (
                typeof parsed === 'object' &&
                parsed !== null &&
                'value' in parsed
            ) {
                return cellText(parsed.value);
            }
        } catch {
            // Plain strings are already display values.
        }
        return value;
    }
    if (typeof value === 'number') {
        return String(value);
    }
    if (value === null || value === undefined) {
        return '—';
    }
    if (typeof value === 'object') {
        if ('value' in value) {
            return cellText(value.value);
        }
        if ('formatted' in value) {
            return cellText(value.formatted);
        }
        if ('raw' in value) {
            return cellText(value.raw);
        }
        return JSON.stringify(value);
    }
    return String(value);
};

const rowCell = (row: ResultRow, columnId: string): string => {
    const cell = row[columnId];
    if (cell === undefined) {
        return '—';
    }
    return cellText(cell);
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
            <Table striped highlightOnHover withTableBorder>
                <Table.Thead className={classes.tableHead}>
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
            <Title order={3} ta="center" className={classes.kpiValue}>
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
    loadingLabel,
    output,
}: {
    loadingLabel: string;
    output: Extract<RenderedChart, { kind: 'custom' }>;
}): ReactElement => {
    const isDark = useComputedColorScheme('light') === 'dark';
    return (
        <Suspense fallback={<Text c="dimmed">{loadingLabel}</Text>}>
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
    noRowsLabel,
    output,
    unavailableLabel,
}: {
    noRowsLabel: string;
    output: Extract<RenderedChart, { kind: 'empty' }>;
    unavailableLabel: string;
}): ReactElement => {
    const label = output.reason === 'noRows' ? noRowsLabel : unavailableLabel;
    return (
        <Paper variant="dotted" p="md">
            <Text c="dimmed" ta="center">
                {label}
            </Text>
        </Paper>
    );
};

const UnsupportedBody = ({
    href,
    openChartLabel,
    unsupportedLabel,
}: {
    href?: string;
    openChartLabel: string;
    unsupportedLabel: string;
}): ReactElement => {
    if (href === undefined) {
        return (
            <Paper variant="dotted" p="md">
                <Text c="dimmed" ta="center">
                    {unsupportedLabel}
                </Text>
            </Paper>
        );
    }
    return (
        <Paper variant="dotted" p="md">
            <Anchor href={href} c="dimmed" aria-label={openChartLabel}>
                <Text c="dimmed" ta="center" fz="sm">
                    {openChartLabel} <IconArrowUpRight size={14} aria-hidden />
                </Text>
            </Anchor>
        </Paper>
    );
};

type Props = {
    href?: string;
    output: RenderedChart;
    secondaryTableOutput?: RenderedChart;
    subtitle?: string;
    title?: string;
};

const AgentBiChartRenderer = ({
    href,
    output,
    secondaryTableOutput,
    subtitle,
    title,
}: Props): ReactElement => {
    const { t } = useAgentBiLocale();
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
            body = (
                <CustomBody
                    loadingLabel={t('renderer.loading')}
                    output={output}
                />
            );
            break;
        case 'empty':
            body = (
                <EmptyBody
                    noRowsLabel={t('renderer.noRows')}
                    output={output}
                    unavailableLabel={t('renderer.unavailable')}
                />
            );
            break;
        case 'unsupported':
            body = (
                <UnsupportedBody
                    href={href}
                    openChartLabel={t('renderer.openChart')}
                    unsupportedLabel={t('renderer.unsupported')}
                />
            );
            break;
        default:
            body = assertUnreachable(output, 'Unknown render output');
    }
    return (
        <Paper p="md" className={classes.root}>
            {title !== undefined || subtitle !== undefined ? (
                <Stack gap={2} mb="xs">
                    {title !== undefined ? (
                        <Title order={5} className={classes.title}>
                            {title}
                        </Title>
                    ) : null}
                    {subtitle !== undefined && subtitle !== '' ? (
                        <Text size="xs" c="dimmed">
                            {subtitle}
                        </Text>
                    ) : null}
                </Stack>
            ) : null}
            {body}
            {secondaryTableOutput?.kind === 'table' ? (
                <div className={classes.splitTable}>
                    <TableBody output={secondaryTableOutput} />
                </div>
            ) : null}
        </Paper>
    );
};

export default AgentBiChartRenderer;
