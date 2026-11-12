import { Button, Card, Code, Group, Stack, Text } from '@mantine/core';
import type { ReactElement } from 'react';

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
    const summary =
        input === undefined || input === null
            ? 'No input details.'
            : JSON.stringify(input, null, 2);
    return (
        <Card
            p="md"
            aria-label={`Approval for ${tool}`}
            data-approval-uuid={approvalUuid}
        >
            <Stack gap="sm">
                <Text fw={600}>Approval required</Text>
                <Text fz="sm" c="dimmed">
                    The assistant wants to run <Code>{tool}</Code>.
                </Text>
                <Code block>{summary}</Code>
                <Group gap="sm">
                    <Button onClick={() => onDecide('approved')}>
                        Approve
                    </Button>
                    <Button
                        variant="default"
                        onClick={() => onDecide('rejected')}
                    >
                        Reject
                    </Button>
                </Group>
            </Stack>
        </Card>
    );
};

export default AgentBiApprovalCard;
