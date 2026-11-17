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
                    aria-label="Expandir espacios de trabajo"
                    title="Expandir espacios de trabajo"
                    onClick={onToggleCollapse}
                >
                    <IconLayoutSidebarLeftExpand size={18} />
                </ActionIcon>
                <ActionIcon
                    variant="subtle"
                    color="indigo"
                    size="md"
                    aria-label="Abrir habilidades"
                    title="Habilidades"
                    onClick={onOpenSkills}
                >
                    <IconBook2 size={16} />
                </ActionIcon>
                <ActionIcon
                    variant="subtle"
                    color="teal"
                    size="md"
                    aria-label="Abrir contexto vivo"
                    title="Contexto vivo"
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
                        Espacios de trabajo
                    </Text>
                </Group>
                <ActionIcon
                    variant="light"
                    color="indigo"
                    size="sm"
                    aria-label="Colapsar espacios de trabajo"
                    title="Colapsar espacios de trabajo"
                    onClick={onToggleCollapse}
                >
                    <IconLayoutSidebarLeftCollapse size={16} />
                </ActionIcon>
            </Group>

            <Group gap="xs" wrap="nowrap">
                <TextInput
                    size="xs"
                    flex={1}
                    aria-label="Nombre del nuevo espacio"
                    placeholder="Nombre del espacio"
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
                    Nuevo
                </Button>
            </Group>

            <Stack gap={6} className={classes.threadList}>
                {isLoadingThreads ? (
                    <EmptyStateLoader title="Cargando espacios…" />
                ) : threadsError !== null && threadsError !== undefined ? (
                    <InlineErrorState message="No se pudieron cargar los espacios." />
                ) : threads.length === 0 ? (
                    <Paper variant="dotted" p="xs">
                        <Text c="dimmed" fz="xs" ta="center">
                            Sin espacios aún.
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
                                {thread.title || 'Sin título'}
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
                            Esquemas de sesión
                        </Text>
                    </Group>
                    <Badge
                        size="xs"
                        color={selectedSchemas.length > 0 ? 'indigo' : 'gray'}
                        variant="light"
                    >
                        {selectedSchemas.length > 0
                            ? `${selectedSchemas.length} activos`
                            : 'Todos'}
                    </Badge>
                </Group>
                <MultiSelect
                    size="xs"
                    aria-label="Esquemas de sesión"
                    placeholder={
                        availableSchemas.length > 0
                            ? 'Selecciona esquemas para esta sesión'
                            : 'Sin esquemas cargados'
                    }
                    data={availableSchemas}
                    value={selectedSchemas}
                    onChange={onChangeSelectedSchemas}
                    searchable
                    clearable
                    nothingFoundMessage="Sin coincidencias"
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
                    Habilidades
                </Button>
                <Button
                    size="xs"
                    variant="light"
                    color="teal"
                    leftSection={<IconCompass size={14} />}
                    onClick={onOpenLiveContext}
                >
                    Contexto vivo
                </Button>
            </Group>
        </Stack>
    );
};

export default AgentBiLeftSidebar;
