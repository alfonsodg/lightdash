import { SegmentedControl, Stack } from '@mantine/core';
import { useState, type FC } from 'react';
import AgentBiChartRenderer from './AgentBiChartRenderer';
import {
    buildAgentBiQueryOutput,
    type AgentBiChartViewMode,
    type AgentBiQueryPreview,
} from './agentBiQueryArtifact';

type Props = {
    preview: AgentBiQueryPreview;
};

const VIEW_MODE_OPTIONS: Array<{ label: string; value: AgentBiChartViewMode }> =
    [
        { label: 'Auto', value: 'auto' },
        { label: 'Bar', value: 'bar' },
        { label: 'Horiz.', value: 'horizontal_bar' },
        { label: 'Line', value: 'line' },
        { label: 'Area', value: 'area' },
        { label: 'Pie', value: 'pie' },
        { label: 'Table', value: 'table' },
    ];

const AgentBiQueryArtifact: FC<Props> = ({ preview }) => {
    const [mode, setMode] = useState<AgentBiChartViewMode>('auto');
    const canSwitchChart =
        preview.dimensions.length > 0 && preview.metrics.length > 0;

    return (
        <Stack gap="xs">
            {canSwitchChart ? (
                <SegmentedControl
                    size="xs"
                    aria-label="Chart view mode"
                    value={mode}
                    onChange={(next) => setMode(next as AgentBiChartViewMode)}
                    data={VIEW_MODE_OPTIONS}
                />
            ) : null}
            <AgentBiChartRenderer
                output={buildAgentBiQueryOutput(preview, mode)}
                title="Query result"
            />
        </Stack>
    );
};

export default AgentBiQueryArtifact;
