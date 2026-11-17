import {
    ActionIcon,
    Group,
    Popover,
    SegmentedControl,
    Stack,
    Switch,
    TextInput,
} from '@mantine/core';
import { IconPencil, IconPin } from '@tabler/icons-react';
import { useState, type FC } from 'react';
import AgentBiChartRenderer from './AgentBiChartRenderer';
import {
    buildAgentBiQueryOutput,
    deriveChartTitle,
    type AgentBiChartMetadata,
    type AgentBiChartViewMode,
    type AgentBiQueryPreview,
} from './agentBiQueryArtifact';

type Props = {
    initialMetadata?: AgentBiChartMetadata;
    initialMode?: AgentBiChartViewMode;
    onMetadataChange?: (metadata: AgentBiChartMetadata) => void;
    onModeChange?: (mode: AgentBiChartViewMode) => void;
    onPinToTab?: (payload: {
        metadata: AgentBiChartMetadata;
        mode: AgentBiChartViewMode;
        preview: AgentBiQueryPreview;
    }) => void;
    preview: AgentBiQueryPreview;
};

const VIEW_MODE_OPTIONS: Array<{ label: string; value: AgentBiChartViewMode }> =
    [
        { label: 'Auto', value: 'auto' },
        { label: 'Barras', value: 'bar' },
        { label: 'Horiz.', value: 'horizontal_bar' },
        { label: 'Líneas', value: 'line' },
        { label: 'Área', value: 'area' },
        { label: 'Circular', value: 'pie' },
        { label: 'Tabla', value: 'table' },
    ];

const AgentBiQueryArtifact: FC<Props> = ({
    initialMetadata,
    initialMode = 'auto',
    onMetadataChange,
    onModeChange,
    onPinToTab,
    preview,
}) => {
    const [mode, setMode] = useState<AgentBiChartViewMode>(initialMode);
    const [metadata, setMetadata] = useState<AgentBiChartMetadata>(
        initialMetadata ?? {},
    );
    const canSwitchChart =
        preview.dimensions.length > 0 && preview.metrics.length > 0;

    const updateMetadata = (patch: Partial<AgentBiChartMetadata>) => {
        const next = { ...metadata, ...patch };
        setMetadata(next);
        onMetadataChange?.(next);
    };

    const resolvedTitle =
        metadata.title !== undefined && metadata.title.trim() !== ''
            ? metadata.title
            : deriveChartTitle(preview);
    const subtitleParts = [
        metadata.subtitle?.trim(),
        metadata.denominator?.trim()
            ? `Denominador: ${metadata.denominator.trim()}`
            : undefined,
    ].filter((part): part is string => Boolean(part && part.length > 0));

    return (
        <Stack gap="xs">
            <Group justify="space-between" gap="xs" wrap="wrap">
                {canSwitchChart ? (
                    <SegmentedControl
                        size="xs"
                        color="indigo"
                        aria-label="Modo de visualización"
                        value={mode}
                        onChange={(next) => {
                            const typed = next as AgentBiChartViewMode;
                            setMode(typed);
                            onModeChange?.(typed);
                        }}
                        data={VIEW_MODE_OPTIONS}
                    />
                ) : (
                    <span />
                )}
                <Group gap={4}>
                    <Popover width={280} position="bottom-end" shadow="md">
                        <Popover.Target>
                            <ActionIcon
                                variant="light"
                                color="indigo"
                                size="sm"
                                aria-label="Editar rótulos del gráfico"
                                title="Editar título, subtítulo, denominador y ejes"
                            >
                                <IconPencil size={15} />
                            </ActionIcon>
                        </Popover.Target>
                        <Popover.Dropdown>
                            <Stack gap="xs">
                                <TextInput
                                    size="xs"
                                    label="Título"
                                    placeholder={deriveChartTitle(preview)}
                                    value={metadata.title ?? ''}
                                    onChange={(event) =>
                                        updateMetadata({
                                            title: event.currentTarget.value,
                                        })
                                    }
                                />
                                <TextInput
                                    size="xs"
                                    label="Subtítulo"
                                    placeholder="Contexto o período"
                                    value={metadata.subtitle ?? ''}
                                    onChange={(event) =>
                                        updateMetadata({
                                            subtitle: event.currentTarget.value,
                                        })
                                    }
                                />
                                <TextInput
                                    size="xs"
                                    label="Denominador"
                                    placeholder="Ej. Total de registros en bronze"
                                    value={metadata.denominator ?? ''}
                                    onChange={(event) =>
                                        updateMetadata({
                                            denominator:
                                                event.currentTarget.value,
                                        })
                                    }
                                />
                                <TextInput
                                    size="xs"
                                    label="Etiqueta eje X"
                                    value={metadata.xAxisLabel ?? ''}
                                    onChange={(event) =>
                                        updateMetadata({
                                            xAxisLabel:
                                                event.currentTarget.value,
                                        })
                                    }
                                />
                                <TextInput
                                    size="xs"
                                    label="Etiqueta eje Y"
                                    value={metadata.yAxisLabel ?? ''}
                                    onChange={(event) =>
                                        updateMetadata({
                                            yAxisLabel:
                                                event.currentTarget.value,
                                        })
                                    }
                                />
                                <Switch
                                    size="xs"
                                    label="Mostrar valores en el gráfico"
                                    checked={metadata.showDataLabels ?? true}
                                    onChange={(event) =>
                                        updateMetadata({
                                            showDataLabels:
                                                event.currentTarget.checked,
                                        })
                                    }
                                />
                            </Stack>
                        </Popover.Dropdown>
                    </Popover>
                    {onPinToTab ? (
                        <ActionIcon
                            variant="light"
                            color="teal"
                            size="sm"
                            aria-label="Fijar en pestaña"
                            title="Fijar en la pestaña activa"
                            onClick={() =>
                                onPinToTab({
                                    metadata: {
                                        ...metadata,
                                        title: resolvedTitle,
                                    },
                                    mode,
                                    preview,
                                })
                            }
                        >
                            <IconPin size={15} />
                        </ActionIcon>
                    ) : null}
                </Group>
            </Group>
            <AgentBiChartRenderer
                output={buildAgentBiQueryOutput(preview, mode, metadata)}
                subtitle={subtitleParts.join(' · ')}
                title={resolvedTitle}
            />
        </Stack>
    );
};

export default AgentBiQueryArtifact;
