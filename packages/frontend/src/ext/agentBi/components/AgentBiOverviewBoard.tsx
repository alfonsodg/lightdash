import {
    Button,
    Group,
    Paper,
    Select,
    SimpleGrid,
    Stack,
    Tabs,
    Text,
    TextInput,
} from '@mantine/core';
import {
    IconFocus2,
    IconPin,
    IconRefresh,
    IconSearch,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import EmptyStateLoader from '../../../components/common/EmptyStateLoader';
import InlineErrorState from '../../../components/common/InlineErrorState';
import { fetchMetricPreview, type AgentBiExploreSummary } from '../api';
import { useProjectExplores } from '../hooks/useProjectExplores';
import { useAgentBiLocale } from '../i18n/agentBiLocale';
import classes from './AgentBiOverviewBoard.module.css';
import AgentBiQueryArtifact from './AgentBiQueryArtifact';
import {
    parseAgentBiQueryPreview,
    type AgentBiChartMetadata,
    type AgentBiChartViewMode,
    type AgentBiQueryPreview,
} from './agentBiQueryArtifact';

export type OverviewSubTab =
    | 'tracking'
    | 'detail'
    | 'subphase'
    | 'hours'
    | 'performance';

export type OverviewCardItem = {
    exploreName: string;
    id: string;
    metadata: AgentBiChartMetadata;
    mode: AgentBiChartViewMode;
    preview: AgentBiQueryPreview;
    tab: OverviewSubTab;
    title: string;
};

type Props = {
    onFocusCard: (card: OverviewCardItem) => void;
    onPinCard: (card: OverviewCardItem) => void;
    projectUuid: string;
};

const classifyExplore = (
    explore: AgentBiExploreSummary,
    index: number,
): OverviewSubTab => {
    const key = `${explore.name} ${explore.label}`.toLowerCase();
    if (/hora|tareo|cuadrilla|obrero|gang/.test(key)) return 'hours';
    if (/rendim|avance_horas|isp|ejecucion|performance/.test(key)) {
        return 'performance';
    }
    if (/subfase|fase|front|frente/.test(key)) return 'subphase';
    if (/detalle|hito|elemento|downtime/.test(key)) return 'detail';
    if (/seguimiento|resumen|reporte|project/.test(key)) return 'tracking';
    const order: OverviewSubTab[] = [
        'tracking',
        'detail',
        'subphase',
        'hours',
        'performance',
    ];
    return order[index % order.length];
};

const defaultModeFor = (
    tab: OverviewSubTab,
    dims: number,
    metrics: number,
): AgentBiChartViewMode => {
    if (dims === 0 || metrics === 0) return 'table';
    if (tab === 'tracking') return 'table';
    if (tab === 'subphase') return 'bar_3d';
    if (tab === 'hours') return 'horizontal_bar';
    if (tab === 'performance') return 'line';
    return 'bar';
};

const AgentBiOverviewBoard: FC<Props> = ({
    onFocusCard,
    onPinCard,
    projectUuid,
}) => {
    const { t } = useAgentBiLocale();
    const {
        data: explores,
        error: exploresError,
        isLoading: loadingExplores,
        refetch,
    } = useProjectExplores(projectUuid);
    const [activeTab, setActiveTab] = useState<OverviewSubTab>('tracking');
    const [search, setSearch] = useState('');
    const [selectedExplore, setSelectedExplore] = useState<string>('all');
    const [cardsByExplore, setCardsByExplore] = useState<
        Record<
            string,
            { error?: boolean; loading: boolean; preview?: AgentBiQueryPreview }
        >
    >({});
    const [refreshNonce, setRefreshNonce] = useState(0);
    const loadedRef = useRef<Set<string>>(new Set());

    const assignedExplores = useMemo(() => {
        const list = (explores ?? []).filter(
            (e) => e.dimensions.length > 0 || e.metrics.length > 0,
        );
        return list.map((explore, idx) => ({
            explore,
            tab: classifyExplore(explore, idx),
        }));
    }, [explores]);

    const visibleExplores = useMemo(() => {
        const term = search.trim().toLowerCase();
        const filtered = assignedExplores.filter(({ explore, tab }) => {
            if (selectedExplore !== 'all' && explore.name !== selectedExplore) {
                return false;
            }
            if (selectedExplore === 'all' && tab !== activeTab) {
                const hasAnyInTab = assignedExplores.some(
                    (entry) => entry.tab === activeTab,
                );
                if (hasAnyInTab) return false;
            }
            if (term.length > 0) {
                return (
                    explore.name.toLowerCase().includes(term) ||
                    explore.label.toLowerCase().includes(term)
                );
            }
            return true;
        });
        return filtered.slice(0, 4);
    }, [activeTab, assignedExplores, search, selectedExplore]);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            for (const { explore } of visibleExplores) {
                const cacheKey = `${refreshNonce}:${explore.name}`;
                if (loadedRef.current.has(cacheKey)) {
                    continue;
                }
                loadedRef.current.add(cacheKey);
                const dims = explore.dimensions.slice(0, 2).map((d) => d.id);
                const mets = explore.metrics.slice(0, 2).map((m) => m.id);
                setCardsByExplore((prev) => ({
                    ...prev,
                    [explore.name]: { loading: true },
                }));
                try {
                    const raw = await fetchMetricPreview(projectUuid, {
                        dimensions: dims,
                        exploreName: explore.name,
                        limit: 25,
                        metrics: mets,
                    });
                    if (cancelled) return;
                    const parsed = parseAgentBiQueryPreview(raw);
                    setCardsByExplore((prev) => ({
                        ...prev,
                        [explore.name]: parsed
                            ? { loading: false, preview: parsed }
                            : { error: true, loading: false },
                    }));
                } catch {
                    if (cancelled) return;
                    setCardsByExplore((prev) => ({
                        ...prev,
                        [explore.name]: {
                            error: true,
                            loading: false,
                        },
                    }));
                }
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [projectUuid, refreshNonce, visibleExplores]);

    const exploreSelectData = [
        { label: t('overview.allExplores'), value: 'all' },
        ...(explores ?? []).map((e) => ({ label: e.label, value: e.name })),
    ];

    return (
        <Stack
            gap="md"
            className={classes.container}
            data-testid="agent-bi-overview-board"
        >
            <Paper className={classes.filterBar}>
                <Group justify="space-between" wrap="wrap" gap="sm">
                    <Stack gap={2}>
                        <Text fw={700} fz="md" c="indigo.9">
                            {t('overview.title')}
                        </Text>
                        <Text fz="xs" c="dimmed">
                            {t('overview.subtitle')}
                        </Text>
                    </Stack>
                    <Group gap="xs" wrap="wrap">
                        <TextInput
                            size="xs"
                            leftSection={<IconSearch size={14} />}
                            placeholder={t('overview.searchPlaceholder')}
                            value={search}
                            onChange={(e) => setSearch(e.currentTarget.value)}
                        />
                        <Select
                            size="xs"
                            aria-label={t('overview.exploreFilter')}
                            value={selectedExplore}
                            data={exploreSelectData}
                            onChange={(val) => setSelectedExplore(val ?? 'all')}
                        />
                        <Button
                            size="xs"
                            variant="light"
                            color="indigo"
                            leftSection={<IconRefresh size={14} />}
                            onClick={() => {
                                setCardsByExplore({});
                                setRefreshNonce((n) => n + 1);
                                void refetch();
                            }}
                        >
                            {t('overview.refresh')}
                        </Button>
                    </Group>
                </Group>
            </Paper>

            <Tabs
                value={activeTab}
                onChange={(val) =>
                    setActiveTab((val as OverviewSubTab) ?? 'tracking')
                }
                variant="pills"
                color="indigo"
            >
                <Tabs.List>
                    <Tabs.Tab value="tracking">
                        {t('overview.tab.tracking')}
                    </Tabs.Tab>
                    <Tabs.Tab value="detail">
                        {t('overview.tab.detail')}
                    </Tabs.Tab>
                    <Tabs.Tab value="subphase">
                        {t('overview.tab.subphase')}
                    </Tabs.Tab>
                    <Tabs.Tab value="hours">{t('overview.tab.hours')}</Tabs.Tab>
                    <Tabs.Tab value="performance">
                        {t('overview.tab.performance')}
                    </Tabs.Tab>
                </Tabs.List>
            </Tabs>

            {loadingExplores ? (
                <EmptyStateLoader title={t('overview.loading')} />
            ) : exploresError ? (
                <InlineErrorState message={t('overview.queryError')} />
            ) : visibleExplores.length === 0 ? (
                <Paper withBorder p="xl" ta="center">
                    <Text c="dimmed" fz="sm">
                        {t('overview.empty')}
                    </Text>
                </Paper>
            ) : (
                <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
                    {visibleExplores.map(({ explore, tab }) => {
                        const state = cardsByExplore[explore.name];
                        const mode = defaultModeFor(
                            tab,
                            explore.dimensions.length,
                            explore.metrics.length,
                        );
                        const cardItem: OverviewCardItem | null = state?.preview
                            ? {
                                  exploreName: explore.name,
                                  id: `overview-${explore.name}`,
                                  metadata: {
                                      paletteName: 'corporate',
                                      showTableBelow: tab === 'detail',
                                      title: explore.label,
                                  },
                                  mode,
                                  preview: state.preview,
                                  tab,
                                  title: explore.label,
                              }
                            : null;
                        return (
                            <Paper key={explore.name} className={classes.card}>
                                <Group
                                    justify="space-between"
                                    mb="xs"
                                    wrap="nowrap"
                                >
                                    <Text fw={600} fz="sm" truncate>
                                        {explore.label}
                                    </Text>
                                    {cardItem ? (
                                        <Group gap={6} wrap="nowrap">
                                            <Button
                                                size="compact-xs"
                                                variant="light"
                                                color="indigo"
                                                leftSection={
                                                    <IconFocus2 size={13} />
                                                }
                                                onClick={() =>
                                                    onFocusCard(cardItem)
                                                }
                                            >
                                                {t('overview.focusExplain')}
                                            </Button>
                                            <Button
                                                size="compact-xs"
                                                variant="light"
                                                color="teal"
                                                leftSection={
                                                    <IconPin size={13} />
                                                }
                                                onClick={() =>
                                                    onPinCard(cardItem)
                                                }
                                            >
                                                {t('overview.pinToWorkspace')}
                                            </Button>
                                        </Group>
                                    ) : null}
                                </Group>
                                {!state || state.loading ? (
                                    <EmptyStateLoader
                                        title={t('overview.loading')}
                                    />
                                ) : state.error ? (
                                    <InlineErrorState
                                        message={t('overview.queryError')}
                                    />
                                ) : cardItem ? (
                                    <AgentBiQueryArtifact
                                        preview={cardItem.preview}
                                        initialMode={cardItem.mode}
                                        initialMetadata={cardItem.metadata}
                                    />
                                ) : null}
                            </Paper>
                        );
                    })}
                </SimpleGrid>
            )}
        </Stack>
    );
};

export default AgentBiOverviewBoard;
