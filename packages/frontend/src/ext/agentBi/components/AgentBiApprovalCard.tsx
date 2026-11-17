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
            ? 'Sin detalles de entrada.'
            : JSON.stringify(input, null, 2);
    return (
        <Card
            p="md"
            aria-label={`Aprobación para ${tool}`}
            data-approval-uuid={approvalUuid}
        >
            <Stack gap="sm">
                <Text fw={600}>Aprobación requerida</Text>
                <Text fz="sm" c="dimmed">
                    El asistente solicita ejecutar <Code>{tool}</Code>.
                </Text>
                <Code block>{summary}</Code>
                <Group gap="sm">
                    <Button color="indigo" onClick={() => onDecide('approved')}>
                        Aprobar
                    </Button>
                    <Button
                        variant="default"
                        onClick={() => onDecide('rejected')}
                    >
                        Rechazar
                    </Button>
                </Group>
            </Stack>
        </Card>
    );
};

export default AgentBiApprovalCard;
