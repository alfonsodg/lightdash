import { subject } from '@casl/ability';
import { Button, Drawer } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useState, type ReactElement } from 'react';
import useIsEmbedded from '../../../ee/providers/Embed/useIsEmbedded';
import useApp from '../../../providers/App/useApp';
import { useAgentBiDashboardContext } from '../hooks/useAgentBiDashboardContext';
import { useAgentBiHealth } from '../hooks/useAgentBiHealth';
import AgentBiWorkspacePage from '../pages/AgentBiWorkspacePage';

type Props = { projectUuid: string };

const AgentBiDashboardLauncher = ({
    projectUuid,
}: Props): ReactElement | null => {
    const [opened, setOpened] = useState(false);
    const context = useAgentBiDashboardContext();
    const { isEnabled } = useAgentBiHealth();
    const { user } = useApp();
    const embedded = useIsEmbedded();
    const organizationUuid = user.data?.organizationUuid ?? '';
    const canView =
        user.data?.ability?.can(
            'view',
            subject('Project', { organizationUuid, projectUuid }),
        ) ?? false;

    if (!isEnabled || !canView || embedded) return null;

    return (
        <>
            <Button
                aria-label="Ask about this dashboard"
                leftSection={<IconSparkles size={16} aria-hidden />}
                onClick={() => setOpened(true)}
                size="xs"
                variant="default"
            >
                Ask about this dashboard
            </Button>
            <Drawer
                onClose={() => setOpened(false)}
                opened={opened}
                position="right"
                size="min(90vw, 1200px)"
                title="Ask about this dashboard"
            >
                <AgentBiWorkspacePage dashboardContext={context} />
            </Drawer>
        </>
    );
};

export default AgentBiDashboardLauncher;
