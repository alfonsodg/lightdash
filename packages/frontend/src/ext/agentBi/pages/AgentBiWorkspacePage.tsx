// Slice 2-3: full-page thread workspace with SSE streaming chat.
import {
    ActionIcon,
    Button,
    Group,
    Paper,
    Stack,
    Text,
    TextInput,
    ThemeIcon,
} from '@mantine/core';
import {
    IconLayoutSidebarRightCollapse,
    IconLayoutSidebarRightExpand,
    IconSparkles,
} from '@tabler/icons-react';
import { useEffect, useState, type FC } from 'react';
import { type Layout } from 'react-grid-layout';
import { useParams } from 'react-router';
import { decideApproval, fetchProjectSchemas } from '../api';
import AgentBiApprovalCard from '../components/AgentBiApprovalCard';
import AgentBiCanvasBoard, {
    type CanvasCard,
    type CanvasTab,
} from '../components/AgentBiCanvasBoard';
import AgentBiContextualDrawer, {
    type AgentBiDrawerContext,
} from '../components/AgentBiContextualDrawer';
import AgentBiLeftSidebar from '../components/AgentBiLeftSidebar';
import {
    deriveChartTitle,
    parseAgentBiQueryPreview,
    type AgentBiChartMetadata,
    type AgentBiChartViewMode,
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
import classes from './AgentBiWorkspacePage.module.css';

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

const DEFAULT_TABS: CanvasTab[] = [
    { cards: [], id: 'tab-overview', name: 'Overview' },
];

const loadSavedTabs = (projectUuid: string): CanvasTab[] => {
    try {
        const raw = localStorage.getItem(`agent-bi-canvas:${projectUuid}`);
        if (!raw) return DEFAULT_TABS;
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed as CanvasTab[];
        }
    } catch {
        // Ignore malformed localStorage state.
    }
    return DEFAULT_TABS;
};

const loadSavedSchemas = (
    projectUuid: string,
    threadUuid: string | null,
): string[] => {
    if (!projectUuid || !threadUuid) return [];
    try {
        const raw = localStorage.getItem(
            `agent-bi-schemas:${projectUuid}:${threadUuid}`,
        );
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
            return parsed.filter((s): s is string => typeof s === 'string');
        }
    } catch {
        // Ignore malformed localStorage state.
    }
    return [];
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
    const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [tabs, setTabs] = useState<CanvasTab[]>(() =>
        loadSavedTabs(projectUuid),
    );
    const [activeTabId, setActiveTabId] = useState<string>(
        () => loadSavedTabs(projectUuid)[0]?.id ?? 'tab-overview',
    );
    const activeThread = selectedThread ?? threads?.[0]?.threadUuid ?? null;
    const [availableSchemas, setAvailableSchemas] = useState<string[]>([]);
    const [selectedSchemas, setSelectedSchemas] = useState<string[]>(() =>
        loadSavedSchemas(projectUuid, activeThread),
    );

    useEffect(() => {
        if (!projectUuid) {
            setAvailableSchemas([]);
            return;
        }
        let cancelled = false;
        void fetchProjectSchemas(projectUuid)
            .then((schemas) => {
                if (!cancelled) {
                    setAvailableSchemas(schemas);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setAvailableSchemas([]);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [projectUuid]);

    useEffect(() => {
        setSelectedSchemas(loadSavedSchemas(projectUuid, activeThread));
    }, [projectUuid, activeThread]);

    const handleChangeSelectedSchemas = (schemas: string[]) => {
        setSelectedSchemas(schemas);
        if (!projectUuid || !activeThread) return;
        try {
            localStorage.setItem(
                `agent-bi-schemas:${projectUuid}:${activeThread}`,
                JSON.stringify(schemas),
            );
        } catch {
            // Ignore storage quota errors.
        }
    };

    useEffect(() => {
        try {
            localStorage.setItem(
                `agent-bi-canvas:${projectUuid}`,
                JSON.stringify(tabs),
            );
        } catch {
            // Ignore storage quota errors.
        }
    }, [projectUuid, tabs]);

    const pinCardToTab = (payload: {
        metadata?: AgentBiChartMetadata;
        mode?: AgentBiChartViewMode;
        preview: AgentBiQueryPreview;
    }) => {
        setTabs((current) =>
            current.map((tab) => {
                if (tab.id !== activeTabId) return tab;
                const count = tab.cards.length;
                const nextCard: CanvasCard = {
                    h: 9,
                    id: `card-${Date.now()}-${count}`,
                    metadata: {
                        title: deriveChartTitle(payload.preview),
                        ...payload.metadata,
                    },
                    mode: payload.mode ?? 'auto',
                    preview: payload.preview,
                    w: 6,
                    x: (count % 2) * 6,
                    y: Math.floor(count / 2) * 9,
                };
                return { ...tab, cards: [...tab.cards, nextCard] };
            }),
        );
    };

    const handleAddTab = (name: string) => {
        const id = `tab-${Date.now()}`;
        setTabs((current) => [...current, { cards: [], id, name }]);
        setActiveTabId(id);
    };

    const handleRemoveTab = (tabId: string) => {
        setTabs((current) => {
            if (current.length <= 1) return current;
            const filtered = current.filter((tab) => tab.id !== tabId);
            if (activeTabId === tabId && filtered[0]) {
                setActiveTabId(filtered[0].id);
            }
            return filtered;
        });
    };

    const handleRemoveCard = (tabId: string, cardId: string) => {
        setTabs((current) =>
            current.map((tab) =>
                tab.id === tabId
                    ? {
                          ...tab,
                          cards: tab.cards.filter((card) => card.id !== cardId),
                      }
                    : tab,
            ),
        );
    };

    const handleUpdateCardMode = (
        tabId: string,
        cardId: string,
        mode: AgentBiChartViewMode,
    ) => {
        setTabs((current) =>
            current.map((tab) =>
                tab.id === tabId
                    ? {
                          ...tab,
                          cards: tab.cards.map((card) =>
                              card.id === cardId ? { ...card, mode } : card,
                          ),
                      }
                    : tab,
            ),
        );
    };

    const handleUpdateCardMetadata = (
        tabId: string,
        cardId: string,
        metadata: AgentBiChartMetadata,
    ) => {
        setTabs((current) =>
            current.map((tab) =>
                tab.id === tabId
                    ? {
                          ...tab,
                          cards: tab.cards.map((card) =>
                              card.id === cardId ? { ...card, metadata } : card,
                          ),
                      }
                    : tab,
            ),
        );
    };

    const handleUpdateLayouts = (tabId: string, layouts: Layout[]) => {
        const byId = new Map(layouts.map((item) => [item.i, item]));
        setTabs((current) =>
            current.map((tab) =>
                tab.id === tabId
                    ? {
                          ...tab,
                          cards: tab.cards.map((card) => {
                              const next = byId.get(card.id);
                              if (!next) return card;
                              return {
                                  ...card,
                                  h: next.h,
                                  w: next.w,
                                  x: next.x,
                                  y: next.y,
                              };
                          }),
                      }
                    : tab,
            ),
        );
    };

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
                pinCardToTab({ preview });
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
        const pinnedContext = dashboardContext?.dashboardSlug
            ? {
                  kind: 'dashboard' as const,
                  slug: dashboardContext.dashboardSlug,
              }
            : dashboardContext?.chartSlug
              ? {
                    kind: 'chart' as const,
                    slug: dashboardContext.chartSlug,
                }
              : undefined;
        const allowedSchemas =
            selectedSchemas.length > 0 ? selectedSchemas : undefined;
        const context: TurnContext = pinnedContext
            ? {
                  pinnedContext,
                  runtimeOverrides: {
                      activeTab: dashboardContext?.activeTab,
                      ...(allowedSchemas ? { allowedSchemas } : {}),
                      dateZoom: dashboardContext?.dateZoom,
                      filters: dashboardContext?.dashboardFilters
                          ? { ...dashboardContext.dashboardFilters }
                          : undefined,
                      parameters: dashboardContext?.parameters,
                  },
              }
            : allowedSchemas
              ? {
                    runtimeOverrides: {
                        allowedSchemas,
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
        <Group
            align="stretch"
            className={classes.layout}
            gap="md"
            p="md"
            wrap="nowrap"
        >
            <AgentBiLeftSidebar
                activeThread={activeThread}
                availableSchemas={availableSchemas}
                collapsed={leftSidebarCollapsed}
                isLoadingThreads={isLoading}
                onChangeSelectedSchemas={handleChangeSelectedSchemas}
                onChangeThreadTitle={setTitle}
                onCreateThread={() => void handleCreate()}
                onOpenLiveContext={() => setDrawerOpen(true)}
                onOpenSkills={() => setSkillsOpen(true)}
                onSelectThread={(threadUuid) => {
                    setSelectedThread(threadUuid);
                    setLines([]);
                }}
                onToggleCollapse={() =>
                    setLeftSidebarCollapsed((prev) => !prev)
                }
                selectedSchemas={selectedSchemas}
                threads={threads ?? []}
                threadsError={error}
                threadTitle={title}
            />
            <Stack gap="md" className={classes.canvas}>
                <AgentBiCanvasBoard
                    tabs={tabs}
                    activeTabId={activeTabId}
                    onSelectTab={setActiveTabId}
                    onAddTab={handleAddTab}
                    onRemoveTab={handleRemoveTab}
                    onRemoveCard={handleRemoveCard}
                    onUpdateCardMode={handleUpdateCardMode}
                    onUpdateCardMetadata={handleUpdateCardMetadata}
                    onUpdateLayouts={handleUpdateLayouts}
                />
            </Stack>
            <Stack
                gap="md"
                data-testid="agent-bi-right-sidebar"
                className={
                    sidebarCollapsed
                        ? classes.sidebarCollapsed
                        : classes.sidebar
                }
            >
                {sidebarCollapsed ? (
                    <ActionIcon
                        variant="light"
                        color="indigo"
                        size="lg"
                        aria-label="Expand sidebar"
                        title="Expand sidebar"
                        onClick={() => setSidebarCollapsed(false)}
                    >
                        <IconLayoutSidebarRightExpand size={18} />
                    </ActionIcon>
                ) : (
                    <>
                        <Group justify="space-between" wrap="nowrap">
                            <Group gap="xs" wrap="nowrap">
                                <ThemeIcon
                                    variant="gradient"
                                    gradient={{
                                        from: 'indigo',
                                        to: 'cyan',
                                        deg: 135,
                                    }}
                                    size="md"
                                    radius="md"
                                >
                                    <IconSparkles size={16} />
                                </ThemeIcon>
                                <Text fw={700} fz="lg" c="indigo.9">
                                    Ask AI
                                </Text>
                            </Group>
                            <ActionIcon
                                variant="light"
                                color="indigo"
                                size="sm"
                                aria-label="Collapse sidebar"
                                title="Collapse sidebar"
                                onClick={() => setSidebarCollapsed(true)}
                            >
                                <IconLayoutSidebarRightCollapse size={16} />
                            </ActionIcon>
                        </Group>
                        <Stack gap="sm" className={classes.messagesPane}>
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
                                    <Paper key={line.id} p="xs" withBorder>
                                        <Group
                                            justify="space-between"
                                            wrap="nowrap"
                                        >
                                            <Text fz="xs" fw={500} truncate>
                                                {deriveChartTitle(line.preview)}
                                            </Text>
                                            <Button
                                                size="compact-xs"
                                                color="teal"
                                                variant="light"
                                                onClick={() =>
                                                    pinCardToTab({
                                                        preview: line.preview,
                                                    })
                                                }
                                            >
                                                Pin to tab
                                            </Button>
                                        </Group>
                                    </Paper>
                                ) : (
                                    <Paper
                                        key={line.id}
                                        p="sm"
                                        withBorder
                                        className={
                                            line.role === 'user'
                                                ? classes.msgUser
                                                : line.role === 'error'
                                                  ? classes.msgError
                                                  : classes.msgAssistant
                                        }
                                    >
                                        <Text
                                            fz="xs"
                                            fw={700}
                                            c={
                                                line.role === 'user'
                                                    ? 'indigo.7'
                                                    : line.role === 'error'
                                                      ? 'red.7'
                                                      : 'blue.7'
                                            }
                                        >
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
                                    onDecide={(decision) =>
                                        void handleDecide(decision)
                                    }
                                    tool={pending.tool}
                                />
                            ) : null}
                        </Stack>
                        <Group gap="sm" className={classes.promptBar}>
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
                                color="indigo"
                                variant="filled"
                                onClick={() => void handleSend()}
                                loading={streaming}
                            >
                                Send
                            </Button>
                        </Group>
                    </>
                )}
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
