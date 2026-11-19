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
    chartSlug?: string;
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

import { useAgentBiLocale } from '../i18n/agentBiLocale';
import type { AgentBiMessageKey } from '../i18n/locales/es';

const rowsOf = (
    context: AgentBiDrawerContext,
    t: (key: AgentBiMessageKey) => string,
): Array<[string, string]> => {
    const rows: Array<[string, string]> = [];
    if (context.chartSlug !== undefined) {
        rows.push([t('drawer.chart'), context.chartSlug]);
    }
    if (context.dashboardSlug !== undefined) {
        rows.push([t('drawer.dashboard'), context.dashboardSlug]);
    }
    if (context.activeTab !== undefined) {
        rows.push([t('drawer.activeTab'), context.activeTab]);
    }
    if (context.dateZoom !== undefined) {
        rows.push([t('drawer.dateZoom'), context.dateZoom]);
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
            `${t('drawer.filterPrefix')} ${filter.target.fieldId}`,
            [filter.operator, ...(filter.values ?? []).map(String)].join(' '),
        ]);
    }
    for (const [key, value] of Object.entries(context.parameters ?? {})) {
        rows.push([`${t('drawer.parameterPrefix')} ${key}`, String(value)]);
    }
    return rows;
};

const AgentBiContextualDrawer: FC<Props> = ({ context, onClose, opened }) => {
    const { t } = useAgentBiLocale();
    const rows = context === null ? [] : rowsOf(context, t);
    return (
        <Drawer opened={opened} onClose={onClose} title={t('drawer.title')}>
            <Stack gap="sm">
                {rows.length === 0 ? (
                    <Text c="dimmed" fz="sm">
                        {t('drawer.empty')}
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
