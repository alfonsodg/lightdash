// Slice 3: contextual drawer. Attach live dashboard context as
// pinnedContext + runtimeOverrides to the next turn.
import {
    type DashboardFilters,
    type ParametersValuesMap,
} from '@lightdash/common';
import { Drawer, Stack, Text } from '@mantine/core';
import type { FC } from 'react';

export type AgentBiDrawerContext = {
    activeTab?: string;
    dashboardFilters?: DashboardFilters;
    dashboardSlug?: string;
    dateZoom?: string;
    parameters?: ParametersValuesMap;
};

type Props = {
    context: AgentBiDrawerContext | null;
    onClose: () => void;
    opened: boolean;
};

const rowsOf = (context: AgentBiDrawerContext): Array<[string, string]> => {
    const rows: Array<[string, string]> = [];
    if (context.dashboardSlug !== undefined) {
        rows.push(['Dashboard', context.dashboardSlug]);
    }
    if (context.activeTab !== undefined) {
        rows.push(['Active tab', context.activeTab]);
    }
    if (context.dateZoom !== undefined) {
        rows.push(['Date zoom', context.dateZoom]);
    }
    const filters = context.dashboardFilters;
    for (const filter of filters
        ? [
              ...filters.dimensions,
              ...filters.metrics,
              ...filters.tableCalculations,
          ]
        : []) {
        rows.push([
            `Filter ${filter.target.fieldId}`,
            [filter.operator, ...(filter.values ?? []).map(String)].join(' '),
        ]);
    }
    for (const [key, value] of Object.entries(context.parameters ?? {})) {
        rows.push([`Parameter ${key}`, String(value)]);
    }
    return rows;
};

const AgentBiContextualDrawer: FC<Props> = ({ context, onClose, opened }) => {
    const rows = context === null ? [] : rowsOf(context);
    return (
        <Drawer opened={opened} onClose={onClose} title="Ask about this view">
            <Stack gap="sm">
                {rows.length === 0 ? (
                    <Text c="dimmed" fz="sm">
                        No live context is attached yet.
                    </Text>
                ) : (
                    rows.map(([key, value]) => (
                        <Stack key={key} gap={0}>
                            <Text fz="xs" c="dimmed">
                                {key}
                            </Text>
                            <Text fz="sm">{value}</Text>
                        </Stack>
                    ))
                )}
            </Stack>
        </Drawer>
    );
};

export default AgentBiContextualDrawer;
