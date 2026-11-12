// Slice 3: contextual drawer. Attach live dashboard context as
// pinnedContext + runtimeOverrides to the next turn.
import { Drawer, Stack, Text } from '@mantine/core';
import type { FC } from 'react';

export type AgentBiDrawerContext = {
    activeTab?: string;
    dashboardFilters?: Array<{ fieldId: string; value: unknown }>;
    dashboardSlug?: string;
    dateZoom?: string;
    parameters?: Record<string, string>;
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
    for (const filter of context.dashboardFilters ?? []) {
        rows.push([`Filter ${filter.fieldId}`, String(filter.value)]);
    }
    for (const [key, value] of Object.entries(context.parameters ?? {})) {
        rows.push([`Parameter ${key}`, value]);
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
