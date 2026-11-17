import {
    ActionIcon,
    Button,
    Group,
    Paper,
    Stack,
    Tabs,
    Text,
    TextInput,
} from '@mantine/core';
import { IconGripVertical, IconPlus, IconX } from '@tabler/icons-react';
import { useState, type FC } from 'react';
import { type Layout } from 'react-grid-layout';
import { ResponsiveGridLayout } from '../../../features/dashboardTabs/ResponsiveGridLayout';
import classes from './AgentBiCanvasBoard.module.css';
import AgentBiQueryArtifact from './AgentBiQueryArtifact';
import type {
    AgentBiChartMetadata,
    AgentBiChartViewMode,
    AgentBiQueryPreview,
} from './agentBiQueryArtifact';

export type CanvasCard = {
    h: number;
    id: string;
    metadata: AgentBiChartMetadata;
    mode: AgentBiChartViewMode;
    preview: AgentBiQueryPreview;
    w: number;
    x: number;
    y: number;
};

export type CanvasTab = {
    cards: CanvasCard[];
    id: string;
    name: string;
};

type Props = {
    activeTabId: string;
    onAddTab: (name: string) => void;
    onRemoveCard: (tabId: string, cardId: string) => void;
    onRemoveTab: (tabId: string) => void;
    onSelectTab: (tabId: string) => void;
    onUpdateCardMetadata: (
        tabId: string,
        cardId: string,
        metadata: AgentBiChartMetadata,
    ) => void;
    onUpdateCardMode: (
        tabId: string,
        cardId: string,
        mode: AgentBiChartViewMode,
    ) => void;
    onUpdateLayouts: (tabId: string, layouts: Layout[]) => void;
    tabs: CanvasTab[];
};

const BREAKPOINTS = { lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 };
const COLS = { lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 };

const AgentBiCanvasBoard: FC<Props> = ({
    activeTabId,
    onAddTab,
    onRemoveCard,
    onRemoveTab,
    onSelectTab,
    onUpdateCardMetadata,
    onUpdateCardMode,
    onUpdateLayouts,
    tabs,
}) => {
    const [newTabName, setNewTabName] = useState('');
    const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

    const handleCreateTab = () => {
        const trimmed = newTabName.trim();
        if (!trimmed) return;
        onAddTab(trimmed);
        setNewTabName('');
    };

    const gridLayout: Layout[] = (activeTab?.cards ?? []).map((card) => ({
        h: card.h,
        i: card.id,
        minH: 6,
        minW: 3,
        w: card.w,
        x: card.x,
        y: card.y,
    }));

    return (
        <Stack gap="md" className={classes.board}>
            <Group
                justify="space-between"
                align="center"
                wrap="wrap"
                gap="sm"
                className={classes.tabBar}
            >
                <Tabs
                    value={activeTab?.id ?? null}
                    onChange={(value) => {
                        if (value) onSelectTab(value);
                    }}
                    variant="pills"
                    color="indigo"
                    className={classes.tabs}
                >
                    <Tabs.List>
                        {tabs.map((tab) => (
                            <Tabs.Tab
                                key={tab.id}
                                value={tab.id}
                                rightSection={
                                    tabs.length > 1 ? (
                                        <ActionIcon
                                            component="span"
                                            size="xs"
                                            variant="subtle"
                                            aria-label={`Eliminar pestaña ${tab.name}`}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                onRemoveTab(tab.id);
                                            }}
                                        >
                                            <IconX size={12} />
                                        </ActionIcon>
                                    ) : undefined
                                }
                            >
                                {tab.name} ({tab.cards.length})
                            </Tabs.Tab>
                        ))}
                    </Tabs.List>
                </Tabs>
                <Group gap="xs" wrap="nowrap">
                    <TextInput
                        size="xs"
                        aria-label="Nombre de pestaña"
                        placeholder="Nombre de pestaña"
                        value={newTabName}
                        onChange={(event) =>
                            setNewTabName(event.currentTarget.value)
                        }
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') handleCreateTab();
                        }}
                    />
                    <Button
                        size="xs"
                        color="indigo"
                        variant="filled"
                        leftSection={<IconPlus size={14} />}
                        onClick={handleCreateTab}
                    >
                        Agregar pestaña
                    </Button>
                </Group>
            </Group>

            {activeTab && activeTab.cards.length === 0 ? (
                <Paper
                    withBorder
                    p="xl"
                    radius="md"
                    className={classes.emptyCanvas}
                >
                    <Stack gap="xs" align="center">
                        <Text fw={700} c="indigo.9">
                            Lienzo de análisis BI
                        </Text>
                        <Text size="sm" c="dimmed" ta="center">
                            Escribe una consulta en el panel derecho. Los
                            gráficos y tablas aparecerán aquí automáticamente y
                            podrás arrastrarlos, redimensionarlos y organizarlos
                            por pestañas.
                        </Text>
                    </Stack>
                </Paper>
            ) : activeTab ? (
                <ResponsiveGridLayout
                    breakpoints={BREAKPOINTS}
                    cols={COLS}
                    layouts={{ lg: gridLayout }}
                    rowHeight={44}
                    draggableHandle=".agent-bi-drag-handle"
                    onLayoutChange={(layout) =>
                        onUpdateLayouts(activeTab.id, layout)
                    }
                    isDraggable
                    isResizable
                    margin={[12, 12]}
                >
                    {activeTab.cards.map((card) => (
                        <div key={card.id}>
                            <Paper
                                withBorder
                                shadow="xs"
                                p="sm"
                                radius="md"
                                className={classes.card}
                            >
                                <Group
                                    justify="space-between"
                                    mb="xs"
                                    wrap="nowrap"
                                    className={classes.dragBar}
                                >
                                    <Group
                                        gap={4}
                                        className={`agent-bi-drag-handle ${classes.dragHandle}`}
                                    >
                                        <IconGripVertical size={15} />
                                        <Text size="xs" c="dimmed">
                                            Arrastrar para priorizar
                                        </Text>
                                    </Group>
                                    <ActionIcon
                                        size="xs"
                                        variant="subtle"
                                        aria-label="Quitar tarjeta"
                                        title="Quitar tarjeta"
                                        onClick={() =>
                                            onRemoveCard(activeTab.id, card.id)
                                        }
                                    >
                                        <IconX size={14} />
                                    </ActionIcon>
                                </Group>
                                <AgentBiQueryArtifact
                                    preview={card.preview}
                                    initialMode={card.mode}
                                    initialMetadata={card.metadata}
                                    onModeChange={(nextMode) =>
                                        onUpdateCardMode(
                                            activeTab.id,
                                            card.id,
                                            nextMode,
                                        )
                                    }
                                    onMetadataChange={(nextMeta) =>
                                        onUpdateCardMetadata(
                                            activeTab.id,
                                            card.id,
                                            nextMeta,
                                        )
                                    }
                                />
                            </Paper>
                        </div>
                    ))}
                </ResponsiveGridLayout>
            ) : null}
        </Stack>
    );
};

export default AgentBiCanvasBoard;
