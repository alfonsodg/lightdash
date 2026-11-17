import {
    ActionIcon,
    Badge,
    Button,
    Divider,
    Group,
    MultiSelect,
    Paper,
    Stack,
    Text,
    ThemeIcon,
} from '@mantine/core';
import {
    IconBook2,
    IconCompass,
    IconDatabase,
    IconLayoutDashboard,
    IconLayoutSidebarLeftCollapse,
    IconLayoutSidebarLeftExpand,
    IconTable,
} from '@tabler/icons-react';
import { type FC } from 'react';
import { type CanvasTab } from './AgentBiCanvasBoard';
import classes from './AgentBiLeftSidebar.module.css';

type Props = {
    activeTabId: string;
    availableSchemas: string[];
    collapsed: boolean;
    hasDashboardContext: boolean;
    onChangeSelectedSchemas: (schemas: string[]) => void;
    onOpenLiveContext: () => void;
    onOpenSkills: () => void;
    onSelectTab: (tabId: string) => void;
    onToggleCollapse: () => void;
    projectUuid: string;
    selectedSchemas: string[];
    tabs: CanvasTab[];
};

const AgentBiLeftSidebar: FC<Props> = ({
    activeTabId,
    availableSchemas,
    collapsed,
    hasDashboardContext,
    onChangeSelectedSchemas,
    onOpenLiveContext,
    onOpenSkills,
    onSelectTab,
    onToggleCollapse,
    projectUuid,
    selectedSchemas,
    tabs,
}) => {
    const totalCards = tabs.reduce((sum, tab) => sum + tab.cards.length, 0);

    if (collapsed) {
        return (
            <Stack
                gap="sm"
                className={classes.leftSidebarCollapsed}
                data-testid="agent-bi-left-sidebar"
            >
                <ActionIcon
                    variant="light"
                    color="indigo"
                    size="lg"
                    aria-label="Expand workspace sidebar"
                    title="Expand workspace sidebar"
                    onClick={onToggleCollapse}
                >
                    <IconLayoutSidebarLeftExpand size={18} />
                </ActionIcon>
                <ActionIcon
                    variant="subtle"
                    color="indigo"
                    size="md"
                    aria-label="Open project skills"
                    title="Project skills"
                    onClick={onOpenSkills}
                >
                    <IconBook2 size={16} />
                </ActionIcon>
                <ActionIcon
                    variant="subtle"
                    color="teal"
                    size="md"
                    aria-label="Open live context"
                    title="Live context"
                    onClick={onOpenLiveContext}
                >
                    <IconCompass size={16} />
                </ActionIcon>
            </Stack>
        );
    }

    return (
        <Stack
            gap="md"
            className={classes.leftSidebar}
            data-testid="agent-bi-left-sidebar"
        >
            <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                    <ThemeIcon
                        variant="gradient"
                        gradient={{ from: 'indigo', to: 'cyan', deg: 135 }}
                        size="md"
                        radius="md"
                    >
                        <IconLayoutDashboard size={16} />
                    </ThemeIcon>
                    <Text fw={700} fz="md" c="indigo.9">
                        Workspace
                    </Text>
                </Group>
                <ActionIcon
                    variant="light"
                    color="indigo"
                    size="sm"
                    aria-label="Collapse workspace sidebar"
                    title="Collapse workspace sidebar"
                    onClick={onToggleCollapse}
                >
                    <IconLayoutSidebarLeftCollapse size={16} />
                </ActionIcon>
            </Group>

            <Paper withBorder p="xs" radius="md" className={classes.infoBanner}>
                <Group justify="space-between" wrap="nowrap">
                    <Text fz="xs" fw={600} c="indigo.9" truncate>
                        {projectUuid
                            ? `Project ${projectUuid.slice(0, 8)}`
                            : 'BI Studio'}
                    </Text>
                    <Badge size="xs" color="cyan" variant="filled">
                        {totalCards} charts
                    </Badge>
                </Group>
            </Paper>

            <Stack gap="xs">
                <Text fz="xs" fw={700} className={classes.sectionHeader}>
                    Canvas Tabs
                </Text>
                <Stack gap={6}>
                    {tabs.map((tab) => {
                        const isActive = tab.id === activeTabId;
                        return (
                            <Button
                                key={tab.id}
                                size="xs"
                                variant={isActive ? 'light' : 'subtle'}
                                color={isActive ? 'indigo' : 'gray'}
                                leftSection={<IconTable size={14} />}
                                rightSection={
                                    <Badge
                                        size="xs"
                                        color={isActive ? 'indigo' : 'gray'}
                                        variant={isActive ? 'filled' : 'light'}
                                    >
                                        {tab.cards.length}
                                    </Badge>
                                }
                                className={classes.tabNavButton}
                                onClick={() => onSelectTab(tab.id)}
                            >
                                {tab.name}
                            </Button>
                        );
                    })}
                </Stack>
            </Stack>

            <Divider color="indigo.1" />

            <Stack gap="xs">
                <Group justify="space-between" wrap="nowrap">
                    <Group gap={4} wrap="nowrap">
                        <IconDatabase size={14} />
                        <Text
                            fz="xs"
                            fw={700}
                            className={classes.sectionHeader}
                        >
                            Session Schemas
                        </Text>
                    </Group>
                    <Badge
                        size="xs"
                        color={selectedSchemas.length > 0 ? 'indigo' : 'gray'}
                        variant="light"
                    >
                        {selectedSchemas.length > 0
                            ? `${selectedSchemas.length} scoped`
                            : 'All'}
                    </Badge>
                </Group>
                <MultiSelect
                    size="xs"
                    aria-label="Session schemas"
                    placeholder={
                        availableSchemas.length > 0
                            ? 'Select schemas for this session'
                            : 'No schemas loaded'
                    }
                    data={availableSchemas}
                    value={selectedSchemas}
                    onChange={onChangeSelectedSchemas}
                    searchable
                    clearable
                    nothingFoundMessage="No matching schema"
                />
                <Text fz="xs" c="dimmed">
                    Scope which schemas this thread can query and cross-join.
                </Text>
            </Stack>

            <Divider color="indigo.1" />

            <Stack gap="xs">
                <Text fz="xs" fw={700} className={classes.sectionHeader}>
                    Context & Skills
                </Text>
                <Button
                    size="xs"
                    variant="light"
                    color="indigo"
                    leftSection={<IconBook2 size={14} />}
                    onClick={onOpenSkills}
                >
                    Project skills
                </Button>
                <Button
                    size="xs"
                    variant="light"
                    color="teal"
                    leftSection={<IconCompass size={14} />}
                    rightSection={
                        hasDashboardContext ? (
                            <Badge size="xs" color="teal" variant="filled">
                                Active
                            </Badge>
                        ) : undefined
                    }
                    onClick={onOpenLiveContext}
                >
                    Live context
                </Button>
            </Stack>
        </Stack>
    );
};

export default AgentBiLeftSidebar;
