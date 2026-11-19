import {
    Button,
    Group,
    Loader,
    Paper,
    Stack,
    Text,
    TextInput,
    ThemeIcon,
} from '@mantine/core';
import { IconArrowLeft, IconSparkles } from '@tabler/icons-react';
import { useEffect, useRef, useState, type FC } from 'react';
import { useAgentBiLocale } from '../i18n/agentBiLocale';
import classes from './AgentBiFocusedView.module.css';
import AgentBiQueryArtifact from './AgentBiQueryArtifact';
import {
    deriveChartTitle,
    type AgentBiChartMetadata,
    type AgentBiChartViewMode,
    type AgentBiQueryPreview,
} from './agentBiQueryArtifact';

export type FocusedCardTarget = {
    id: string;
    metadata: AgentBiChartMetadata;
    mode: AgentBiChartViewMode;
    preview: AgentBiQueryPreview;
    title?: string;
};

export type ExplainerMessage = {
    id: string;
    role: 'assistant' | 'user';
    text: string;
};

type Props = {
    explaining: boolean;
    focusedCard: FocusedCardTarget | null;
    messages: ExplainerMessage[];
    onBackToOverview: () => void;
    onExplainCard: (card: FocusedCardTarget, followUp?: string) => void;
};

const AgentBiFocusedView: FC<Props> = ({
    explaining,
    focusedCard,
    messages,
    onBackToOverview,
    onExplainCard,
}) => {
    const { locale, t } = useAgentBiLocale();
    const [followUp, setFollowUp] = useState('');
    const autoTriggeredIdRef = useRef<string | null>(null);

    useEffect(() => {
        if (
            focusedCard !== null &&
            messages.length === 0 &&
            !explaining &&
            autoTriggeredIdRef.current !== focusedCard.id
        ) {
            autoTriggeredIdRef.current = focusedCard.id;
            onExplainCard(focusedCard);
        }
    }, [explaining, focusedCard, messages.length, onExplainCard]);

    if (focusedCard === null) {
        return (
            <Paper
                withBorder
                p="xl"
                ta="center"
                data-testid="agent-bi-focused-view"
            >
                <Stack gap="sm" align="center">
                    <Text fw={700} fz="md" c="indigo.9">
                        {t('focused.title')}
                    </Text>
                    <Text fz="sm" c="dimmed">
                        {t('focused.noCard')}
                    </Text>
                    <Button
                        size="xs"
                        variant="light"
                        color="indigo"
                        leftSection={<IconArrowLeft size={14} />}
                        onClick={onBackToOverview}
                    >
                        {t('focused.backToOverview')}
                    </Button>
                </Stack>
            </Paper>
        );
    }

    const title =
        focusedCard.title ??
        focusedCard.metadata.title ??
        deriveChartTitle(focusedCard.preview, locale);

    const handleSendFollowUp = () => {
        const trimmed = followUp.trim();
        if (!trimmed || explaining) return;
        setFollowUp('');
        onExplainCard(focusedCard, trimmed);
    };

    return (
        <Group
            gap="md"
            className={classes.layout}
            data-testid="agent-bi-focused-view"
        >
            <Paper className={classes.mainPane}>
                <Group justify="space-between" mb="sm" wrap="wrap">
                    <Group gap="xs">
                        <Button
                            size="compact-xs"
                            variant="subtle"
                            color="indigo"
                            leftSection={<IconArrowLeft size={14} />}
                            onClick={onBackToOverview}
                        >
                            {t('focused.backToOverview')}
                        </Button>
                        <Text fw={700} fz="md">
                            {title}
                        </Text>
                    </Group>
                    <Button
                        size="xs"
                        variant="light"
                        color="indigo"
                        leftSection={<IconSparkles size={14} />}
                        loading={explaining}
                        onClick={() => onExplainCard(focusedCard)}
                    >
                        {t('focused.explainButton')}
                    </Button>
                </Group>
                <AgentBiQueryArtifact
                    preview={focusedCard.preview}
                    initialMode={focusedCard.mode}
                    initialMetadata={{
                        ...focusedCard.metadata,
                        showTableBelow:
                            focusedCard.metadata.showTableBelow ?? true,
                    }}
                />
            </Paper>

            <Paper className={classes.explainerPane}>
                <Group gap="xs" mb="sm">
                    <ThemeIcon
                        variant="gradient"
                        gradient={{ from: 'indigo', to: 'cyan', deg: 135 }}
                        size="md"
                        radius="md"
                    >
                        <IconSparkles size={16} />
                    </ThemeIcon>
                    <Text fw={700} fz="md" c="indigo.9">
                        {t('focused.explainerTitle')}
                    </Text>
                </Group>

                <Stack gap="sm" className={classes.messagesScroll}>
                    {messages.length === 0 && !explaining ? (
                        <Text fz="sm" c="dimmed">
                            {t('focused.explainerEmpty')}
                        </Text>
                    ) : null}
                    {messages.map((msg) => (
                        <Paper
                            key={msg.id}
                            p="sm"
                            withBorder
                            className={
                                msg.role === 'user'
                                    ? classes.msgUser
                                    : classes.msgAssistant
                            }
                        >
                            <Text
                                fz="xs"
                                fw={700}
                                c={msg.role === 'user' ? 'indigo.7' : 'blue.7'}
                            >
                                {msg.role === 'user'
                                    ? t('rightSidebar.role.user')
                                    : t('rightSidebar.role.assistant')}
                            </Text>
                            <Text fz="sm">{msg.text}</Text>
                        </Paper>
                    ))}
                    {explaining ? (
                        <Group gap="xs">
                            <Loader size="xs" color="indigo" />
                            <Text fz="xs" c="dimmed">
                                {t('focused.explaining')}
                            </Text>
                        </Group>
                    ) : null}
                </Stack>

                <Group gap="xs" mt="sm">
                    <TextInput
                        flex={1}
                        size="xs"
                        aria-label={t('focused.followUpPlaceholder')}
                        placeholder={t('focused.followUpPlaceholder')}
                        value={followUp}
                        onChange={(e) => setFollowUp(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSendFollowUp();
                        }}
                    />
                    <Button
                        size="xs"
                        color="indigo"
                        loading={explaining}
                        onClick={handleSendFollowUp}
                    >
                        {t('rightSidebar.send')}
                    </Button>
                </Group>
            </Paper>
        </Group>
    );
};

export default AgentBiFocusedView;
