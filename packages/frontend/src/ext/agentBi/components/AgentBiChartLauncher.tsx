import { subject } from '@casl/ability';
import { Button, Drawer } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useState, type ReactElement } from 'react';
import { useParams } from 'react-router';
import useIsEmbedded from '../../../ee/providers/Embed/useIsEmbedded';
import {
    selectSavedChart,
    useExplorerSelector,
} from '../../../features/explorer/store';
import useApp from '../../../providers/App/useApp';
import { useAgentBiHealth } from '../hooks/useAgentBiHealth';
import AgentBiWorkspacePage from '../pages/AgentBiWorkspacePage';

const AgentBiChartLauncher = (): ReactElement | null => {
    const [opened, setOpened] = useState(false);
    const { projectUuid = '' } = useParams<{ projectUuid: string }>();
    const savedChart = useExplorerSelector(selectSavedChart);
    const { isEnabled } = useAgentBiHealth();
    const { user } = useApp();
    const embedded = useIsEmbedded();
    const organizationUuid = user.data?.organizationUuid ?? '';
    const canView =
        projectUuid.length > 0 &&
        (user.data?.ability?.can(
            'view',
            subject('Project', { organizationUuid, projectUuid }),
        ) ??
            false);

    if (!isEnabled || !canView || embedded || !savedChart?.slug) {
        return null;
    }

    return (
        <>
            <Button
                aria-label="Ask about this chart"
                leftSection={<IconSparkles size={16} aria-hidden />}
                onClick={() => setOpened(true)}
                size="xs"
                variant="default"
            >
                Ask about this chart
            </Button>
            <Drawer
                onClose={() => setOpened(false)}
                opened={opened}
                position="right"
                size="min(90vw, 1200px)"
                title="Ask about this chart"
            >
                <AgentBiWorkspacePage
                    dashboardContext={{
                        chartSlug: savedChart.slug,
                        parameters: savedChart.parameters,
                    }}
                />
            </Drawer>
        </>
    );
};

export default AgentBiChartLauncher;
