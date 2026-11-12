// Slice 2-3: full-page thread workspace with SSE streaming chat.
import { Button, Group, Paper, Stack, Text, TextInput } from '@mantine/core';
import { useState, type FC } from 'react';
import { useParams } from 'react-router';
import EmptyStateLoader from '../../../components/common/EmptyStateLoader';
import InlineErrorState from '../../../components/common/InlineErrorState';
import { decideApproval } from '../api';
import AgentBiApprovalCard from '../components/AgentBiApprovalCard';
import AgentBiContextualDrawer, {
    type AgentBiDrawerContext,
} from '../components/AgentBiContextualDrawer';
import AgentBiQueryArtifact from '../components/AgentBiQueryArtifact';
import {
    parseAgentBiQueryPreview,
    type AgentBiQueryPreview,
} from '../components/agentBiQueryArtifact';
import ProjectSkillsModal from '../components/ProjectSkillsModal';
import { useAgentBiMessages } from '../hooks/useAgentBiMessages';
import {
    streamThreadTurn,
    type AgentBiStreamEvent,
    type StreamInput,
} from '../hooks/useAgentBiStream';
import { useAgentBiThreads } from '../hooks/useAgentBiThreads';

type PendingApproval = {
    approvalUuid: string;
    context: TurnContext;
    input: unknown;
    tool: string;
};

type TurnContext = Pick<StreamInput, 'pinnedContext' | 'runtimeOverrides'>;

type ChatLine =
    | { id: string; kind: 'message'; role: string; text: string }
    | { id: string; kind: 'query-artifact'; preview: AgentBiQueryPreview };

type Props = {
    dashboardContext?: AgentBiDrawerContext | null;
};

const AgentBiWorkspacePage: FC<Props> = ({ dashboardContext = null }) => {
    const { projectUuid = '' } = useParams();
    const {
        data: threads,
        isLoading,
        error,
        create,
    } = useAgentBiThreads(projectUuid);
    const [selectedThread, setSelectedThread] = useState<string | null>(null);
    const { data: storedMessages } = useAgentBiMessages(
        projectUuid,
        selectedThread,
    );
    const [title, setTitle] = useState('');
    const [draft, setDraft] = useState('');
    const [lines, setLines] = useState<ChatLine[]>([]);
    const [pending, setPending] = useState<PendingApproval | null>(null);
    const [streaming, setStreaming] = useState(false);
    const [skillsOpen, setSkillsOpen] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const activeThread = selectedThread ?? threads?.[0]?.threadUuid ?? null;

    const handleCreate = async () => {
        if (title.trim().length === 0) {
            return;
        }
        const created = await create(title.trim());
        setTitle('');
        setSelectedThread(created.threadUuid);
        setLines([]);
    };

    const appendLine = (role: string, text: string) => {
        setLines((current) => [
            ...current,
            { id: `line-${current.length}`, kind: 'message', role, text },
        ]);
    };

    const handleEvent = (event: AgentBiStreamEvent, context: TurnContext) => {
        if (event.type === 'text_delta') {
            const text =
                typeof event.data === 'object' &&
                event.data !== null &&
                'text' in event.data
                    ? String((event.data as { text: unknown }).text)
                    : '';
            appendLine('assistant', text);
        } else if (event.type === 'approval_required') {
            const data = event.data as {
                approvalUuid?: string;
                input?: unknown;
                tool?: string;
            };
            setPending({
                approvalUuid: String(data.approvalUuid ?? ''),
                context,
                input: data.input ?? null,
                tool: String(data.tool ?? 'run_sql'),
            });
        } else if (event.type === 'chart_artifact') {
            const data =
                typeof event.data === 'object' && event.data !== null
                    ? (event.data as Record<string, unknown>)
                    : null;
            const preview = parseAgentBiQueryPreview(data?.preview);
            if (preview !== null) {
                setLines((current) => [
                    ...current,
                    {
                        id: `line-${current.length}`,
                        kind: 'query-artifact',
                        preview,
                    },
                ]);
            }
        } else if (event.type === 'error') {
            appendLine('error', 'The turn failed.');
        }
    };

    const handleSend = async () => {
        if (activeThread === null || draft.trim().length === 0 || streaming) {
            return;
        }
        const text = draft.trim();
        const context: TurnContext = dashboardContext?.dashboardSlug
            ? {
                  pinnedContext: {
                      kind: 'dashboard',
                      slug: dashboardContext.dashboardSlug,
                  },
                  runtimeOverrides: {
                      activeTab: dashboardContext.activeTab,
                      dateZoom: dashboardContext.dateZoom,
                      filters: dashboardContext.dashboardFilters
                          ? { ...dashboardContext.dashboardFilters }
                          : undefined,
                      parameters: dashboardContext.parameters,
                  },
              }
            : {};
        setDraft('');
        setStreaming(true);
        appendLine('user', text);
        try {
            await streamThreadTurn(
                {
                    projectUuid,
                    threadUuid: activeThread,
                    userText: text,
                    ...context,
                },
                (event) => handleEvent(event, context),
            );
        } finally {
            setStreaming(false);
        }
    };

    const handleDecide = async (decision: 'approved' | 'rejected') => {
        if (pending === null || activeThread === null) {
            return;
        }
        await decideApproval(
            projectUuid,
            activeThread,
            pending.approvalUuid,
            decision,
        );
        const approved = pending;
        setPending(null);
        if (decision === 'approved') {
            setStreaming(true);
            try {
                await streamThreadTurn(
                    {
                        projectUuid,
                        resumeApproved: {
                            approvalUuid: approved.approvalUuid,
                            input: approved.input,
                            tool: approved.tool,
                        },
                        threadUuid: activeThread,
                        ...approved.context,
                    },
                    (event) => handleEvent(event, approved.context),
                );
            } finally {
                setStreaming(false);
            }
        }
    };

    const persisted = (storedMessages ?? []).map((message) => message.content);

    return (
        <Group align="flex-start" gap="lg" p="lg" wrap="nowrap">
            <Stack gap="md" w={280}>
                <Text fw={600} fz="lg">
                    Ask AI
                </Text>
                <Stack gap="sm">
                    <TextInput
                        aria-label="New thread title"
                        placeholder="New thread title"
                        value={title}
                        onChange={(event) =>
                            setTitle(event.currentTarget.value)
                        }
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                void handleCreate();
                            }
                        }}
                    />
                    <Button onClick={() => void handleCreate()}>
                        New thread
                    </Button>
                </Stack>
                {isLoading ? (
                    <EmptyStateLoader title="Loading threads…" />
                ) : error !== null && error !== undefined ? (
                    <InlineErrorState message="Could not load threads." />
                ) : (threads ?? []).length === 0 ? (
                    <Paper variant="dotted" p="md">
                        <Text c="dimmed" ta="center">
                            No threads yet.
                        </Text>
                    </Paper>
                ) : (
                    (threads ?? []).map((thread) => (
                        <Paper
                            key={thread.threadUuid}
                            p="sm"
                            withBorder
                            onClick={() => {
                                setSelectedThread(thread.threadUuid);
                                setLines([]);
                            }}
                            className={
                                thread.threadUuid === activeThread
                                    ? 'is-active'
                                    : undefined
                            }
                        >
                            <Text fw={500} truncate>
                                {thread.title || 'Untitled'}
                            </Text>
                        </Paper>
                    ))
                )}
                <Button variant="default" onClick={() => setSkillsOpen(true)}>
                    Project skills
                </Button>
                <Button variant="default" onClick={() => setDrawerOpen(true)}>
                    Live context
                </Button>
            </Stack>
            <Stack gap="md" flex={1}>
                {persisted.length > 0 ? (
                    <Stack gap="xs">
                        {persisted.map((content, index) => (
                            <Paper key={index} p="sm" withBorder>
                                <Text fz="sm">{content}</Text>
                            </Paper>
                        ))}
                    </Stack>
                ) : null}
                {lines.map((line) =>
                    line.kind === 'query-artifact' ? (
                        <AgentBiQueryArtifact
                            key={line.id}
                            preview={line.preview}
                        />
                    ) : (
                        <Paper key={line.id} p="sm" withBorder>
                            <Text fz="xs" c="dimmed">
                                {line.role}
                            </Text>
                            <Text fz="sm">{line.text}</Text>
                        </Paper>
                    ),
                )}
                {pending !== null ? (
                    <AgentBiApprovalCard
                        approvalUuid={pending.approvalUuid}
                        input={pending.input}
                        onDecide={(decision) => void handleDecide(decision)}
                        tool={pending.tool}
                    />
                ) : null}
                <Group gap="sm">
                    <TextInput
                        aria-label="Ask a question"
                        placeholder="Ask a question…"
                        value={draft}
                        flex={1}
                        onChange={(event) =>
                            setDraft(event.currentTarget.value)
                        }
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                void handleSend();
                            }
                        }}
                    />
                    <Button
                        onClick={() => void handleSend()}
                        loading={streaming}
                    >
                        Send
                    </Button>
                </Group>
            </Stack>
            <ProjectSkillsModal
                opened={skillsOpen}
                onClose={() => setSkillsOpen(false)}
                projectUuid={projectUuid}
            />
            <AgentBiContextualDrawer
                opened={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                context={dashboardContext}
            />
        </Group>
    );
};

export default AgentBiWorkspacePage;
