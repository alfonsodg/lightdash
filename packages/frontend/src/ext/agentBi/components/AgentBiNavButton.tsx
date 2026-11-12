import { subject } from '@casl/ability';
import { Button } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';
import useApp from '../../../providers/App/useApp';
import { useAgentBiHealth } from '../hooks/useAgentBiHealth';

type Props = {
    projectUuid: string;
};

const AgentBiNavButton = ({ projectUuid }: Props): ReactElement | null => {
    const { isEnabled } = useAgentBiHealth();
    const { user } = useApp();
    const navigate = useNavigate();

    const organizationUuid = user.data?.organizationUuid ?? '';
    const canView =
        user.data?.ability?.can(
            'view',
            subject('Project', { organizationUuid, projectUuid }),
        ) ?? false;

    if (!isEnabled || !canView) {
        return null;
    }

    const goToWorkspace = () =>
        void navigate(`/projects/${projectUuid}/agent-bi`);

    return (
        <Button
            aria-label="Ask AI"
            size="xs"
            variant="default"
            fz="sm"
            leftSection={<IconSparkles size={16} aria-hidden />}
            onClick={goToWorkspace}
        >
            Ask AI
        </Button>
    );
};

export default AgentBiNavButton;
