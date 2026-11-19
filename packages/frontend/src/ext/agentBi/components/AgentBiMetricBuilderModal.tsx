import {
    Button,
    Group,
    MultiSelect,
    Paper,
    Select,
    Stack,
    Switch,
    TextInput,
} from '@mantine/core';
import { IconChartBar, IconPin } from '@tabler/icons-react';
import { useEffect, useMemo, useState, type FC } from 'react';
import InlineErrorState from '../../../components/common/InlineErrorState';
import MantineModal from '../../../components/common/MantineModal';
import { fetchMetricPreview } from '../api';
import { useProjectExplores } from '../hooks/useProjectExplores';
import { useAgentBiLocale } from '../i18n/agentBiLocale';
import AgentBiQueryArtifact from './AgentBiQueryArtifact';
import {
    parseAgentBiQueryPreview,
    type AgentBiChartMetadata,
    type AgentBiChartViewMode,
    type AgentBiPaletteKey,
    type AgentBiQueryPreview,
} from './agentBiQueryArtifact';

type Props = {
    onClose: () => void;
    onPinMetric: (payload: {
        metadata: AgentBiChartMetadata;
        mode: AgentBiChartViewMode;
        preview: AgentBiQueryPreview;
    }) => void;
    opened: boolean;
    projectUuid: string;
};

const MODES: AgentBiChartViewMode[] = [
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

const PALETTES: AgentBiPaletteKey[] = [
    'corporate',
    'emerald',
    'ocean',
    'sunset',
    'contrast',
];

const AgentBiMetricBuilderModal: FC<Props> = ({
    onClose,
    onPinMetric,
    opened,
    projectUuid,
}) => {
    const { t } = useAgentBiLocale();
    const { data: explores } = useProjectExplores(projectUuid);
    const [exploreName, setExploreName] = useState<string>('');
    const [dimensions, setDimensions] = useState<string[]>([]);
    const [metrics, setMetrics] = useState<string[]>([]);
    const [title, setTitle] = useState('');
    const [mode, setMode] = useState<AgentBiChartViewMode>('bar_3d');
    const [paletteName, setPaletteName] =
        useState<AgentBiPaletteKey>('corporate');
    const [showTableBelow, setShowTableBelow] = useState(false);
    const [loading, setLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [preview, setPreview] = useState<AgentBiQueryPreview | null>(null);

    useEffect(() => {
        if (!exploreName && explores && explores.length > 0) {
            setExploreName(explores[0].name);
        }
    }, [exploreName, explores]);

    const currentExplore = useMemo(
        () => (explores ?? []).find((e) => e.name === exploreName) ?? null,
        [exploreName, explores],
    );

    const handleExploreChange = (next: string | null) => {
        setExploreName(next ?? '');
        setDimensions([]);
        setMetrics([]);
        setPreview(null);
        setErrorMsg(null);
    };

    const handlePreview = async () => {
        if (!exploreName) return;
        if (dimensions.length === 0 && metrics.length === 0) {
            setErrorMsg(t('builder.noFields'));
            return;
        }
        setLoading(true);
        setErrorMsg(null);
        try {
            const raw = await fetchMetricPreview(projectUuid, {
                dimensions,
                exploreName,
                limit: 50,
                metrics,
            });
            const parsed = parseAgentBiQueryPreview(raw);
            if (!parsed) {
                setErrorMsg(t('builder.previewError'));
            } else {
                setPreview(parsed);
            }
        } catch {
            setErrorMsg(t('builder.previewError'));
        } finally {
            setLoading(false);
        }
    };

    const handlePin = () => {
        if (!preview) return;
        onPinMetric({
            metadata: {
                paletteName,
                showTableBelow,
                ...(title.trim() ? { title: title.trim() } : {}),
            },
            mode,
            preview,
        });
        onClose();
    };

    return (
        <MantineModal
            opened={opened}
            onClose={onClose}
            title={t('builder.modalTitle')}
            size="lg"
        >
            <Stack gap="sm">
                <Select
                    label={t('builder.exploreLabel')}
                    data={(explores ?? []).map((e) => ({
                        label: e.label,
                        value: e.name,
                    }))}
                    value={exploreName}
                    onChange={handleExploreChange}
                    searchable
                />
                <Group grow align="flex-start">
                    <MultiSelect
                        label={t('builder.dimensionsLabel')}
                        data={(currentExplore?.dimensions ?? []).map((d) => ({
                            label: d.label,
                            value: d.id,
                        }))}
                        value={dimensions}
                        onChange={setDimensions}
                        searchable
                        clearable
                    />
                    <MultiSelect
                        label={t('builder.metricsLabel')}
                        data={(currentExplore?.metrics ?? []).map((m) => ({
                            label: m.label,
                            value: m.id,
                        }))}
                        value={metrics}
                        onChange={setMetrics}
                        searchable
                        clearable
                    />
                </Group>
                <Group grow>
                    <TextInput
                        label={t('builder.titleLabel')}
                        placeholder={t('builder.titlePlaceholder')}
                        value={title}
                        onChange={(e) => setTitle(e.currentTarget.value)}
                    />
                    <Select
                        label={t('builder.modeLabel')}
                        data={MODES.map((m) => ({
                            label: t(`chart.mode.${m}`),
                            value: m,
                        }))}
                        value={mode}
                        onChange={(val) =>
                            setMode((val as AgentBiChartViewMode) ?? 'auto')
                        }
                    />
                    <Select
                        label={t('builder.paletteLabel')}
                        data={PALETTES.map((p) => ({
                            label: t(`chart.palette.${p}`),
                            value: p,
                        }))}
                        value={paletteName}
                        onChange={(val) =>
                            setPaletteName(
                                (val as AgentBiPaletteKey) ?? 'corporate',
                            )
                        }
                    />
                </Group>
                <Switch
                    size="xs"
                    label={t('builder.showTableLabel')}
                    checked={showTableBelow}
                    onChange={(e) => setShowTableBelow(e.currentTarget.checked)}
                />
                {errorMsg ? <InlineErrorState message={errorMsg} /> : null}
                <Group justify="flex-end" gap="xs">
                    <Button
                        variant="light"
                        color="indigo"
                        leftSection={<IconChartBar size={15} />}
                        loading={loading}
                        onClick={() => void handlePreview()}
                    >
                        {t('builder.previewButton')}
                    </Button>
                    <Button
                        color="teal"
                        leftSection={<IconPin size={15} />}
                        disabled={!preview}
                        onClick={handlePin}
                    >
                        {t('builder.pinButton')}
                    </Button>
                </Group>
                {preview ? (
                    <Paper withBorder p="sm">
                        <AgentBiQueryArtifact
                            preview={preview}
                            initialMode={mode}
                            initialMetadata={{
                                paletteName,
                                showTableBelow,
                                ...(title.trim()
                                    ? { title: title.trim() }
                                    : {}),
                            }}
                        />
                    </Paper>
                ) : null}
            </Stack>
        </MantineModal>
    );
};

export default AgentBiMetricBuilderModal;
