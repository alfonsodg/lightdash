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
    TextInput,
    ThemeIcon,
} from '@mantine/core';
import {
    IconBook2,
    IconCompass,
    IconDatabase,
    IconLayoutDashboard,
    IconLayoutSidebarLeftCollapse,
    IconLayoutSidebarLeftExpand,
} from '@tabler/icons-react';
import { type FC } from 'react';
import EmptyStateLoader from '../../../components/common/EmptyStateLoader';
import InlineErrorState from '../../../components/common/InlineErrorState';
import { type AgentBiThread } from '../api';
import classes from './AgentBiLeftSidebar.module.css';

type Props = {
    activeThread: string | null;
    availableSchemas: string[];
    collapsed: boolean;
    isLoadingThreads: boolean;
    onChangeSelectedSchemas: (schemas: string[]) => void;
    onChangeThreadTitle: (title: string) => void;
    onCreateThread: () => void;
    onOpenLiveContext: () => void;
    onOpenSkills: () => void;
    onSelectThread: (threadUuid: string) => void;
    onToggleCollapse: () => void;
    selectedSchemas: string[];
    threads: AgentBiThread[];
    threadsError: unknown;
    threadTitle: string;
};

const AgentBiLeftSidebar: FC<Props> = ({
    activeThread,
    availableSchemas,
    collapsed,
    isLoadingThreads,
    onChangeSelectedSchemas,
    onChangeThreadTitle,
    onCreateThread,
    onOpenLiveContext,
    onOpenSkills,
    onSelectThread,
    onToggleCollapse,
    selectedSchemas,
    threads,
    threadsError,
    threadTitle,
}) => {
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
            gap="sm"
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
                        Workspaces
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

            <Group gap="xs" wrap="nowrap">
                <TextInput
                    size="xs"
                    flex={1}
                    aria-label="New thread title"
                    placeholder="New workspace name"
                    value={threadTitle}
                    onChange={(event) =>
                        onChangeThreadTitle(event.currentTarget.value)
                    }
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            onCreateThread();
                        }
                    }}
                />
                <Button
                    size="xs"
                    color="indigo"
                    variant="filled"
                    onClick={onCreateThread}
                >
                    New thread
                </Button>
            </Group>

            <Stack gap={6} className={classes.threadList}>
                {isLoadingThreads ? (
                    <EmptyStateLoader title="Loading workspaces…" />
                ) : threadsError !== null && threadsError !== undefined ? (
                    <InlineErrorState message="Could not load workspaces." />
                ) : threads.length === 0 ? (
                    <Paper variant="dotted" p="xs">
                        <Text c="dimmed" fz="xs" ta="center">
                            No workspaces yet.
                        </Text>
                    </Paper>
                ) : (
                    threads.map((thread) => (
                        <Paper
                            key={thread.threadUuid}
                            p="xs"
                            withBorder
                            onClick={() => onSelectThread(thread.threadUuid)}
                            className={
                                thread.threadUuid === activeThread
                                    ? `${classes.threadItemActive} is-active`
                                    : classes.threadItem
                            }
                        >
                            <Text
                                fw={
                                    thread.threadUuid === activeThread
                                        ? 600
                                        : 500
                                }
                                fz="xs"
                                c={
                                    thread.threadUuid === activeThread
                                        ? 'indigo.9'
                                        : undefined
                                }
                                truncate
                            >
                                {thread.title || 'Untitled'}
                            </Text>
                        </Paper>
                    ))
                )}
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
            </Stack>

            <Divider color="indigo.1" />

            <Group gap="xs" grow>
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
                    onClick={onOpenLiveContext}
                >
                    Live context
                </Button>
            </Group>
        </Stack>
    );
};

export default AgentBiLeftSidebar;
