import { Button, Card, Code, Group, Stack, Text } from '@mantine/core';
import type { ReactElement } from 'react';
import { useAgentBiLocale } from '../i18n/agentBiLocale';

type Decision = 'approved' | 'rejected';

type Props = {
    approvalUuid: string;
    input: unknown;
    onDecide: (decision: Decision) => void;
    tool: string;
};

const AgentBiApprovalCard = ({
    approvalUuid,
    input,
    onDecide,
    tool,
}: Props): ReactElement => {
    const { t } = useAgentBiLocale();
    const summary =
        input === undefined || input === null
            ? t('approval.noDetails')
            : JSON.stringify(input, null, 2);
    return (
        <Card
            p="md"
            aria-label={`${t('approval.ariaPrefix')} ${tool}`}
            data-approval-uuid={approvalUuid}
        >
            <Stack gap="sm">
                <Text fw={600}>{t('approval.title')}</Text>
                <Text fz="sm" c="dimmed">
                    {t('approval.promptPrefix')} <Code>{tool}</Code>.
                </Text>
                <Code block>{summary}</Code>
                <Group gap="sm">
                    <Button color="indigo" onClick={() => onDecide('approved')}>
                        {t('approval.approve')}
                    </Button>
                    <Button
                        variant="default"
                        onClick={() => onDecide('rejected')}
                    >
                        {t('approval.reject')}
                    </Button>
                </Group>
            </Stack>
        </Card>
    );
};

export default AgentBiApprovalCard;
