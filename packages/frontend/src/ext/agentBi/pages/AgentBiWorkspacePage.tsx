// Slice 2-3: full-page thread workspace with SSE streaming chat.
import {
    ActionIcon,
    Button,
    Group,
    Paper,
    SegmentedControl,
    Stack,
    Text,
    TextInput,
    ThemeIcon,
} from '@mantine/core';
import {
    IconLayoutSidebarRightCollapse,
    IconLayoutSidebarRightExpand,
    IconPlus,
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
import AgentBiFocusedView, {
    type ExplainerMessage,
    type FocusedCardTarget,
} from '../components/AgentBiFocusedView';
import AgentBiLeftSidebar from '../components/AgentBiLeftSidebar';
import AgentBiMetricBuilderModal from '../components/AgentBiMetricBuilderModal';
import AgentBiOverviewBoard, {
    type OverviewCardItem,
} from '../components/AgentBiOverviewBoard';
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
import { useAgentBiLocale } from '../i18n/agentBiLocale';
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
    { cards: [], id: 'tab-overview', name: 'Resumen' },
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
    const { locale, setLocale, t } = useAgentBiLocale();
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
    const [builderOpen, setBuilderOpen] = useState(false);
    const [viewMode, setViewMode] = useState<
        'overview' | 'focused' | 'workspace'
    >('workspace');
    const [focusedCard, setFocusedCard] = useState<FocusedCardTarget | null>(
        null,
    );
    const [explainerByCard, setExplainerByCard] = useState<
        Record<string, ExplainerMessage[]>
    >({});
    const [explaining, setExplaining] = useState(false);
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
            appendLine('error', t('rightSidebar.turnFailed'));
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
                      locale,
                      parameters: dashboardContext?.parameters,
                  },
              }
            : {
                  runtimeOverrides: {
                      ...(allowedSchemas ? { allowedSchemas } : {}),
                      locale,
                  },
              };
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

    const handleFocusCard = (card: OverviewCardItem) => {
        setFocusedCard({
            id: card.id,
            metadata: card.metadata,
            mode: card.mode,
            preview: card.preview,
            title: card.title,
        });
        setViewMode('focused');
    };

    const handleExplainCard = async (
        card: FocusedCardTarget,
        followUp?: string,
    ) => {
        if (explaining) return;
        let targetThread = activeThread;
        if (targetThread === null) {
            const created = await create(
                card.title ?? t('focused.explainerTitle'),
            );
            targetThread = created.threadUuid;
            setSelectedThread(targetThread);
        }
        const compactRows = card.preview.rows.slice(0, 15).map((row) =>
            Object.fromEntries(
                Object.entries(row).map(([k, v]) => {
                    if (
                        typeof v === 'object' &&
                        v !== null &&
                        'value' in v &&
                        typeof (v as { value?: unknown }).value === 'object' &&
                        (v as { value?: unknown }).value !== null
                    ) {
                        const inner = (
                            v as {
                                value: { formatted?: unknown; raw?: unknown };
                            }
                        ).value;
                        return [k, inner.formatted ?? inner.raw ?? v];
                    }
                    return [k, v];
                }),
            ),
        );
        const promptText = followUp
            ? `${followUp}\n\n[No uses herramientas externas ni consultes el catálogo; responde directamente con los datos de la tarjeta "${card.title ?? card.id}": ${JSON.stringify(compactRows.slice(0, 12))}]`
            : locale === 'es'
              ? `No uses herramientas externas ni consultes el catálogo; analiza directamente los datos proporcionados. Explica de forma ejecutiva qué muestra "${card.title ?? deriveChartTitle(card.preview, locale)}", destaca tendencias, máximos, mínimos y posibles cuellos de botella con estos datos reales: ${JSON.stringify(compactRows)}`
              : `Do not call any tools or query the catalog; analyze the provided data directly. Provide an executive explanation of "${card.title ?? deriveChartTitle(card.preview, locale)}", highlighting trends, highs, lows, and potential bottlenecks from these rows: ${JSON.stringify(compactRows)}`;

        if (followUp) {
            setExplainerByCard((prev) => ({
                ...prev,
                [card.id]: [
                    ...(prev[card.id] ?? []),
                    {
                        id: `u-${Date.now()}`,
                        role: 'user',
                        text: followUp,
                    },
                ],
            }));
        }

        const assistantMsgId = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setExplaining(true);
        try {
            await streamThreadTurn(
                {
                    projectUuid,
                    runtimeOverrides: { locale },
                    threadUuid: targetThread,
                    userText: promptText,
                },
                (event) => {
                    if (
                        event.type === 'text_delta' &&
                        typeof event.data === 'object' &&
                        event.data !== null &&
                        'text' in event.data
                    ) {
                        const delta = String(
                            (event.data as { text: unknown }).text,
                        );
                        setExplainerByCard((prev) => {
                            const existing = prev[card.id] ?? [];
                            const idx = existing.findIndex(
                                (m) => m.id === assistantMsgId,
                            );
                            if (idx >= 0) {
                                const updated = [...existing];
                                updated[idx] = {
                                    ...updated[idx],
                                    text: `${updated[idx].text}${delta}`,
                                };
                                return { ...prev, [card.id]: updated };
                            }
                            return {
                                ...prev,
                                [card.id]: [
                                    ...existing,
                                    {
                                        id: assistantMsgId,
                                        role: 'assistant',
                                        text: delta,
                                    },
                                ],
                            };
                        });
                    } else if (
                        event.type === 'error' &&
                        typeof event.data === 'object' &&
                        event.data !== null &&
                        'message' in event.data
                    ) {
                        const errMsg = String(
                            (event.data as { message: unknown }).message,
                        );
                        setExplainerByCard((prev) => ({
                            ...prev,
                            [card.id]: [
                                ...(prev[card.id] ?? []),
                                {
                                    id: assistantMsgId,
                                    role: 'assistant',
                                    text: errMsg,
                                },
                            ],
                        }));
                    }
                },
            );
        } finally {
            setExplaining(false);
        }
    };

    return (
        <Stack gap={0} className={classes.outerShell}>
            <Group
                justify="space-between"
                align="center"
                wrap="wrap"
                gap="sm"
                className={classes.topBar}
            >
                <SegmentedControl
                    size="xs"
                    color="indigo"
                    aria-label={t('viewMode.aria')}
                    value={viewMode}
                    onChange={(val) =>
                        setViewMode(
                            (val as 'overview' | 'focused' | 'workspace') ??
                                'workspace',
                        )
                    }
                    data={[
                        {
                            label: t('viewMode.overview'),
                            value: 'overview',
                        },
                        {
                            label: t('viewMode.focused'),
                            value: 'focused',
                        },
                        {
                            label: t('viewMode.workspace'),
                            value: 'workspace',
                        },
                    ]}
                />
                <Group gap="xs" wrap="nowrap">
                    <Button
                        size="xs"
                        color="teal"
                        variant="light"
                        leftSection={<IconPlus size={14} />}
                        onClick={() => setBuilderOpen(true)}
                    >
                        {t('builder.openButton')}
                    </Button>
                </Group>
            </Group>

            {viewMode === 'overview' ? (
                <Stack p="md" className={classes.canvas}>
                    <AgentBiOverviewBoard
                        projectUuid={projectUuid}
                        onFocusCard={handleFocusCard}
                        onPinCard={(card) => {
                            pinCardToTab({
                                metadata: card.metadata,
                                mode: card.mode,
                                preview: card.preview,
                            });
                            setViewMode('workspace');
                        }}
                    />
                </Stack>
            ) : viewMode === 'focused' ? (
                <Stack p="md" className={classes.canvas}>
                    <AgentBiFocusedView
                        explaining={explaining}
                        focusedCard={focusedCard}
                        messages={
                            focusedCard
                                ? (explainerByCard[focusedCard.id] ?? [])
                                : []
                        }
                        onBackToOverview={() => setViewMode('overview')}
                        onExplainCard={(card, followUp) =>
                            void handleExplainCard(card, followUp)
                        }
                    />
                </Stack>
            ) : (
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
                                aria-label={t('rightSidebar.expand')}
                                title={t('rightSidebar.expand')}
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
                                            {t('rightSidebar.title')}
                                        </Text>
                                    </Group>
                                    <Group gap="xs" wrap="nowrap">
                                        <SegmentedControl
                                            size="xs"
                                            aria-label={t('locale.label')}
                                            value={locale}
                                            onChange={(value) =>
                                                setLocale(
                                                    value === 'en'
                                                        ? 'en'
                                                        : 'es',
                                                )
                                            }
                                            data={[
                                                {
                                                    label: t('locale.es'),
                                                    value: 'es',
                                                },
                                                {
                                                    label: t('locale.en'),
                                                    value: 'en',
                                                },
                                            ]}
                                        />
                                        <ActionIcon
                                            variant="light"
                                            color="indigo"
                                            size="sm"
                                            aria-label={t(
                                                'rightSidebar.collapse',
                                            )}
                                            title={t('rightSidebar.collapse')}
                                            onClick={() =>
                                                setSidebarCollapsed(true)
                                            }
                                        >
                                            <IconLayoutSidebarRightCollapse
                                                size={16}
                                            />
                                        </ActionIcon>
                                    </Group>
                                </Group>
                                <Stack
                                    gap="sm"
                                    className={classes.messagesPane}
                                >
                                    {persisted.length > 0 ? (
                                        <Stack gap="xs">
                                            {persisted.map((content, index) => (
                                                <Paper
                                                    key={index}
                                                    p="sm"
                                                    withBorder
                                                >
                                                    <Text fz="sm">
                                                        {content}
                                                    </Text>
                                                </Paper>
                                            ))}
                                        </Stack>
                                    ) : null}
                                    {lines.map((line) =>
                                        line.kind === 'query-artifact' ? (
                                            <Paper
                                                key={line.id}
                                                p="xs"
                                                withBorder
                                            >
                                                <Group
                                                    justify="space-between"
                                                    wrap="nowrap"
                                                >
                                                    <Text
                                                        fz="xs"
                                                        fw={500}
                                                        truncate
                                                    >
                                                        {deriveChartTitle(
                                                            line.preview,
                                                            locale,
                                                        )}
                                                    </Text>
                                                    <Button
                                                        size="compact-xs"
                                                        color="teal"
                                                        variant="light"
                                                        onClick={() =>
                                                            pinCardToTab({
                                                                preview:
                                                                    line.preview,
                                                            })
                                                        }
                                                    >
                                                        {t('chart.pinToTab')}
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
                                                            : line.role ===
                                                                'error'
                                                              ? 'red.7'
                                                              : 'blue.7'
                                                    }
                                                >
                                                    {line.role === 'user'
                                                        ? t(
                                                              'rightSidebar.role.user',
                                                          )
                                                        : line.role === 'error'
                                                          ? t(
                                                                'rightSidebar.role.error',
                                                            )
                                                          : t(
                                                                'rightSidebar.role.assistant',
                                                            )}
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
                                        aria-label={t('rightSidebar.inputAria')}
                                        placeholder={t(
                                            'rightSidebar.inputPlaceholder',
                                        )}
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
                                        {t('rightSidebar.send')}
                                    </Button>
                                </Group>
                            </>
                        )}
                    </Stack>
                </Group>
            )}
            <ProjectSkillsModal
                opened={skillsOpen}
                onClose={() => setSkillsOpen(false)}
                projectUuid={projectUuid}
            />
            <AgentBiMetricBuilderModal
                opened={builderOpen}
                onClose={() => setBuilderOpen(false)}
                projectUuid={projectUuid}
                onPinMetric={(payload) => {
                    pinCardToTab(payload);
                    setViewMode('workspace');
                }}
            />
            <AgentBiContextualDrawer
                opened={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                context={dashboardContext}
            />
        </Stack>
    );
};

export default AgentBiWorkspacePage;
