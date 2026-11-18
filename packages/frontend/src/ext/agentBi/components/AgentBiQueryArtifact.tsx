import {
    ActionIcon,
    Group,
    Popover,
    SegmentedControl,
    Select,
    Stack,
    Switch,
    TextInput,
} from '@mantine/core';
import { IconDownload, IconPencil, IconPin } from '@tabler/icons-react';
import { useState, type FC } from 'react';
import { useAgentBiLocale } from '../i18n/agentBiLocale';
import AgentBiChartRenderer from './AgentBiChartRenderer';
import {
    buildAgentBiQueryOutput,
    deriveChartTitle,
    exportPreviewToCsv,
    type AgentBiChartMetadata,
    type AgentBiChartViewMode,
    type AgentBiPaletteKey,
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

const QUICK_MODES: AgentBiChartViewMode[] = [
    'auto',
    'bar',
    'line',
    'donut',
    'bar_3d',
    'table',
];

const ALL_MODES: AgentBiChartViewMode[] = [
    'auto',
    'bar',
    'horizontal_bar',
    'line',
    'area',
    'pie',
    'donut',
    'funnel',
    'radar',
    'treemap',
    'scatter',
    'bar_3d',
    'table',
];

const PALETTE_KEYS: AgentBiPaletteKey[] = [
    'corporate',
    'emerald',
    'ocean',
    'sunset',
    'contrast',
];

const AgentBiQueryArtifact: FC<Props> = ({
    initialMetadata,
    initialMode = 'auto',
    onMetadataChange,
    onModeChange,
    onPinToTab,
    preview,
}) => {
    const { locale, t } = useAgentBiLocale();
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

    const handleModeChange = (next: AgentBiChartViewMode) => {
        setMode(next);
        onModeChange?.(next);
    };

    const handleDownloadCsv = () => {
        const csv = exportPreviewToCsv(preview);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${resolvedTitle.toLowerCase().replace(/[^a-z0-9]+/gi, '-')}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    };

    const resolvedTitle =
        metadata.title !== undefined && metadata.title.trim() !== ''
            ? metadata.title
            : deriveChartTitle(preview, locale);
    const subtitleParts = [
        metadata.subtitle?.trim(),
        metadata.denominator?.trim()
            ? `${t('chart.denominatorPrefix')} ${metadata.denominator.trim()}`
            : undefined,
    ].filter((part): part is string => Boolean(part && part.length > 0));

    const quickModeOptions = QUICK_MODES.map((m) => ({
        label: t(`chart.mode.${m}`),
        value: m,
    }));

    const allModeOptions = ALL_MODES.map((m) => ({
        label: t(`chart.mode.${m}`),
        value: m,
    }));

    const paletteOptions = PALETTE_KEYS.map((key) => ({
        label: t(`chart.palette.${key}`),
        value: key,
    }));

    const primaryOutput = buildAgentBiQueryOutput(preview, mode, metadata);
    const showSplitTable =
        Boolean(metadata.showTableBelow) && primaryOutput.kind !== 'table';
    const secondaryTableOutput = showSplitTable
        ? buildAgentBiQueryOutput(preview, 'table', metadata)
        : undefined;

    return (
        <Stack gap="xs">
            <Group justify="space-between" gap="xs" wrap="wrap">
                {canSwitchChart ? (
                    <Group gap="xs" wrap="wrap">
                        <SegmentedControl
                            size="xs"
                            color="indigo"
                            aria-label={t('chart.modeAriaLabel')}
                            value={
                                QUICK_MODES.includes(mode) ? mode : undefined
                            }
                            onChange={(next) =>
                                handleModeChange(next as AgentBiChartViewMode)
                            }
                            data={quickModeOptions}
                        />
                        <Select
                            size="xs"
                            w={125}
                            aria-label={t('chart.modeAriaLabel')}
                            value={mode}
                            data={allModeOptions}
                            onChange={(next) => {
                                if (next) {
                                    handleModeChange(
                                        next as AgentBiChartViewMode,
                                    );
                                }
                            }}
                        />
                    </Group>
                ) : (
                    <span />
                )}
                <Group gap={4}>
                    <ActionIcon
                        variant="light"
                        color="blue"
                        size="sm"
                        aria-label={t('chart.downloadCsv')}
                        title={t('chart.downloadCsv')}
                        onClick={handleDownloadCsv}
                    >
                        <IconDownload size={15} />
                    </ActionIcon>
                    <Popover width={295} position="bottom-end" shadow="md">
                        <Popover.Target>
                            <ActionIcon
                                variant="light"
                                color="indigo"
                                size="sm"
                                aria-label={t('chart.editLabels')}
                                title={t('chart.editLabelsTitle')}
                            >
                                <IconPencil size={15} />
                            </ActionIcon>
                        </Popover.Target>
                        <Popover.Dropdown>
                            <Stack gap="xs">
                                <TextInput
                                    size="xs"
                                    label={t('chart.field.title')}
                                    placeholder={deriveChartTitle(
                                        preview,
                                        locale,
                                    )}
                                    value={metadata.title ?? ''}
                                    onChange={(event) =>
                                        updateMetadata({
                                            title: event.currentTarget.value,
                                        })
                                    }
                                />
                                <TextInput
                                    size="xs"
                                    label={t('chart.field.subtitle')}
                                    placeholder={t(
                                        'chart.field.subtitlePlaceholder',
                                    )}
                                    value={metadata.subtitle ?? ''}
                                    onChange={(event) =>
                                        updateMetadata({
                                            subtitle: event.currentTarget.value,
                                        })
                                    }
                                />
                                <TextInput
                                    size="xs"
                                    label={t('chart.field.denominator')}
                                    placeholder={t(
                                        'chart.field.denominatorPlaceholder',
                                    )}
                                    value={metadata.denominator ?? ''}
                                    onChange={(event) =>
                                        updateMetadata({
                                            denominator:
                                                event.currentTarget.value,
                                        })
                                    }
                                />
                                <Select
                                    size="xs"
                                    label={t('chart.field.palette')}
                                    value={metadata.paletteName ?? 'corporate'}
                                    data={paletteOptions}
                                    onChange={(val) => {
                                        if (val) {
                                            updateMetadata({
                                                paletteName:
                                                    val as AgentBiPaletteKey,
                                            });
                                        }
                                    }}
                                />
                                <TextInput
                                    size="xs"
                                    label={t('chart.field.xAxis')}
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
                                    label={t('chart.field.yAxis')}
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
                                    label={t('chart.field.showDataLabels')}
                                    checked={metadata.showDataLabels ?? true}
                                    onChange={(event) =>
                                        updateMetadata({
                                            showDataLabels:
                                                event.currentTarget.checked,
                                        })
                                    }
                                />
                                <Switch
                                    size="xs"
                                    label={t('chart.field.showTableBelow')}
                                    checked={metadata.showTableBelow ?? false}
                                    onChange={(event) =>
                                        updateMetadata({
                                            showTableBelow:
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
                            aria-label={t('chart.pinToTab')}
                            title={t('chart.pinToTabTitle')}
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
                output={primaryOutput}
                secondaryTableOutput={secondaryTableOutput}
                subtitle={subtitleParts.join(' · ')}
                title={resolvedTitle}
            />
        </Stack>
    );
};

export default AgentBiQueryArtifact;
