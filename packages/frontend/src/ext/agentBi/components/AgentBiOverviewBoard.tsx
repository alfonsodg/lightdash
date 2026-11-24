import {
    ActionIcon,
    Button,
    Checkbox,
    Group,
    Select,
    Stack,
    Table,
    Text,
} from '@mantine/core';
import {
    IconChevronDown,
    IconChevronRight,
    IconFocus2,
    IconPin,
    IconRefresh,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState, type FC } from 'react';
import EmptyStateLoader from '../../../components/common/EmptyStateLoader';
import InlineErrorState from '../../../components/common/InlineErrorState';
import EChartsReact from '../../../components/EChartsReactWrapper';
import { useProjectExplores } from '../hooks/useProjectExplores';
import { useAgentBiLocale } from '../i18n/agentBiLocale';
import classes from './AgentBiOverviewBoard.module.css';
import {
    type AgentBiChartMetadata,
    type AgentBiChartViewMode,
    type AgentBiQueryPreview,
} from './agentBiQueryArtifact';
import {
    formatCompactNumber,
    formatDecimal,
    loadIspAnalyticsDataset,
    type IspAnalyticsDataset,
    type IspHierarchyRow,
} from './ispAnalyticsAdapter';

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

type PbiSubView = 'inicio' | 'sin_factor' | 'pf_diario' | 'indicadores';

const pfDotClass = (pf: number): string => {
    if (pf >= 1.0) return classes.pfDotGreen;
    if (pf >= 0.85) return classes.pfDotAmber;
    return classes.pfDotRed;
};

const buildSyntheticComboPreview = (
    points: {
        hhGanadas: number;
        hhGastadas: number;
        pfAcum: number;
        pfSem: number;
        week: string;
    }[],
): AgentBiQueryPreview => ({
    columns: {
        Semana: { format: null, label: 'Semana', type: 'string' },
        hh_ganadas: { format: null, label: 'HH Ganadas', type: 'number' },
        hh_gastadas: { format: null, label: 'HH Gastadas', type: 'number' },
        pf_actual: { format: null, label: 'PF Actual', type: 'number' },
        pf_acumulado: { format: null, label: 'PF Acumulado', type: 'number' },
    },
    dimensions: ['Semana'],
    metrics: ['hh_ganadas', 'hh_gastadas', 'pf_actual', 'pf_acumulado'],
    rows: points.map((p) => ({
        Semana: p.week,
        hh_ganadas: Math.round(p.hhGanadas),
        hh_gastadas: Math.round(p.hhGastadas),
        pf_actual: Number(p.pfSem.toFixed(2)),
        pf_acumulado: Number(p.pfAcum.toFixed(2)),
    })),
});

const AgentBiOverviewBoard: FC<Props> = ({
    onFocusCard,
    onPinCard,
    projectUuid,
}) => {
    const { locale } = useAgentBiLocale();
    const {
        data: explores,
        error: exploresError,
        isLoading: loadingExplores,
    } = useProjectExplores(projectUuid);

    const [dataset, setDataset] = useState<IspAnalyticsDataset | null>(null);
    const [loadingData, setLoadingData] = useState(false);
    const [loadErr, setLoadErr] = useState<string | null>(null);
    const [refreshTick, setRefreshTick] = useState(0);

    const [pbiView, setPbiView] = useState<PbiSubView>('inicio');
    const [selectedWeek, setSelectedWeek] = useState<string>('ALL');
    const [selectedArea, setSelectedArea] = useState<string>('ALL');
    const [selectedFrente, setSelectedFrente] = useState<string>('ALL');
    const [selectedDisciplines, setSelectedDisciplines] = useState<string[]>(
        [],
    );
    const [expandedAreas, setExpandedAreas] = useState<Record<string, boolean>>(
        {},
    );

    useEffect(() => {
        if (!explores || explores.length === 0) return;
        let cancelled = false;
        setLoadingData(true);
        setLoadErr(null);
        void loadIspAnalyticsDataset(projectUuid, explores)
            .then((res) => {
                if (cancelled) return;
                setDataset(res);
                const firstArea = res.areas[0];
                if (firstArea) {
                    setExpandedAreas({ [firstArea]: true });
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setLoadErr(
                        err instanceof Error
                            ? err.message
                            : 'Error loading BI data',
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setLoadingData(false);
            });
        return () => {
            cancelled = true;
        };
    }, [explores, projectUuid, refreshTick]);

    const filteredWeekly = useMemo(() => {
        if (!dataset) return [];
        return dataset.weeklyPoints.filter((w) => {
            if (selectedWeek !== 'ALL' && w.week !== selectedWeek) return false;
            if (selectedArea !== 'ALL' && w.area !== selectedArea) return false;
            if (selectedFrente !== 'ALL' && w.frente !== selectedFrente) {
                return false;
            }
            if (
                selectedDisciplines.length > 0 &&
                !selectedDisciplines.includes(w.disciplina)
            ) {
                return false;
            }
            return true;
        });
    }, [
        dataset,
        selectedArea,
        selectedDisciplines,
        selectedFrente,
        selectedWeek,
    ]);

    const filteredHierarchy = useMemo(() => {
        if (!dataset) return [];
        return dataset.hierarchyRows.filter((h) => {
            if (selectedWeek !== 'ALL' && h.week !== selectedWeek) return false;
            if (selectedArea !== 'ALL' && h.area !== selectedArea) return false;
            if (selectedFrente !== 'ALL' && h.frente !== selectedFrente) {
                return false;
            }
            if (
                selectedDisciplines.length > 0 &&
                !selectedDisciplines.includes(h.disciplina)
            ) {
                return false;
            }
            return true;
        });
    }, [
        dataset,
        selectedArea,
        selectedDisciplines,
        selectedFrente,
        selectedWeek,
    ]);

    const aggregatedWeekly = useMemo(() => {
        const byWeek = new Map<string, { hhGan: number; hhGast: number }>();
        for (const p of filteredWeekly) {
            const cur = byWeek.get(p.week) ?? { hhGan: 0, hhGast: 0 };
            cur.hhGan += p.hhGanadas;
            cur.hhGast += p.hhGastadas;
            byWeek.set(p.week, cur);
        }
        let accGan = 0;
        let accGast = 0;
        return Array.from(byWeek.entries()).map(([week, val]) => {
            accGan += val.hhGan;
            accGast += val.hhGast;
            const pfSem = val.hhGast > 0 ? val.hhGan / val.hhGast : 1;
            const pfAcum = accGast > 0 ? accGan / accGast : 1;
            return {
                hhGanadas: val.hhGan,
                hhGastadas: val.hhGast,
                pfAcum,
                pfSem,
                week,
            };
        });
    }, [filteredWeekly]);

    const kpis = useMemo(() => {
        const latest = aggregatedWeekly[aggregatedWeekly.length - 1];
        const hhGanSem = latest
            ? latest.hhGanadas
            : filteredHierarchy.reduce((s, r) => s + r.hhGanadasSem, 0);
        const hhGastSem = latest
            ? latest.hhGastadas
            : filteredHierarchy.reduce((s, r) => s + r.hhGastadasSem, 0);
        const pfSem = hhGastSem > 0 ? hhGanSem / hhGastSem : 1;

        const hhGanAcum =
            aggregatedWeekly.length > 0
                ? aggregatedWeekly.reduce((s, r) => s + r.hhGanadas, 0)
                : filteredHierarchy.reduce((s, r) => s + r.hhGanadasAcum, 0);
        const hhGastAcum =
            aggregatedWeekly.length > 0
                ? aggregatedWeekly.reduce((s, r) => s + r.hhGastadas, 0)
                : filteredHierarchy.reduce((s, r) => s + r.hhGastadasAcum, 0);
        const pfAcum = hhGastAcum > 0 ? hhGanAcum / hhGastAcum : 1;

        return {
            hhGanAcum,
            hhGanSem,
            hhGastAcum,
            hhGastSem,
            pfAcum,
            pfSem,
        };
    }, [aggregatedWeekly, filteredHierarchy]);

    const groupedMatrix = useMemo(() => {
        const map = new Map<string, IspHierarchyRow[]>();
        for (const row of filteredHierarchy) {
            const list = map.get(row.area) ?? [];
            list.push(row);
            map.set(row.area, list);
        }
        return Array.from(map.entries()).map(([area, children]) => {
            const cantFisicoSem = children.reduce(
                (s, c) => s + c.cantFisicoSem,
                0,
            );
            const hhGastadasSem = children.reduce(
                (s, c) => s + c.hhGastadasSem,
                0,
            );
            const hhGanadasSem = children.reduce(
                (s, c) => s + c.hhGanadasSem,
                0,
            );
            const modSem = children.reduce((s, c) => s + c.modSem, 0);
            const hhGastadasAcum = children.reduce(
                (s, c) => s + c.hhGastadasAcum,
                0,
            );
            const hhGanadasAcum = children.reduce(
                (s, c) => s + c.hhGanadasAcum,
                0,
            );
            return {
                area,
                cantFisicoSem,
                children,
                hhGanadasAcum,
                hhGanadasSem,
                hhGastadasAcum,
                hhGastadasSem,
                modSem,
                pfAcum: hhGastadasAcum > 0 ? hhGanadasAcum / hhGastadasAcum : 1,
                pfSem: hhGastadasSem > 0 ? hhGanadasSem / hhGastadasSem : 1,
            };
        });
    }, [filteredHierarchy]);

    const comboChartOption = useMemo(() => {
        const xLabels = aggregatedWeekly.map((p) => p.week);
        const pfValues = aggregatedWeekly.flatMap((p) => [p.pfSem, p.pfAcum]);
        const pfMin = pfValues.length > 0 ? Math.min(...pfValues) : 0.7;
        const pfMax = pfValues.length > 0 ? Math.max(...pfValues) : 1.1;
        const y2Min = Number(Math.max(0, pfMin - 0.12).toFixed(2));
        const y2Max = Number((pfMax + 0.15).toFixed(2));
        const formatBarK = (val: number) =>
            Math.abs(val) >= 1000
                ? `${Math.round(val / 1000)}K`
                : `${Math.round(val)}`;

        return {
            backgroundColor: 'transparent',
            grid: { bottom: 28, left: 46, right: 44, top: 44 },
            legend: {
                data: [
                    'HH GANADAS',
                    'HH GASTADAS',
                    'PF Actual',
                    'PF Acumulado',
                ],
                top: 6,
            },
            series: [
                {
                    data: aggregatedWeekly.map((p) => Math.round(p.hhGanadas)),
                    itemStyle: { borderRadius: [2, 2, 0, 0], color: '#93c5fd' },
                    label: {
                        backgroundColor: 'rgba(255,255,255,0.85)',
                        borderRadius: 3,
                        color: '#1e3a8a',
                        fontSize: 10,
                        fontWeight: 'bold',
                        formatter: (params: { value: number }) =>
                            formatBarK(params.value),
                        padding: [2, 4],
                        position: 'insideTop',
                        show: true,
                    },
                    name: 'HH GANADAS',
                    type: 'bar',
                },
                {
                    data: aggregatedWeekly.map((p) => Math.round(p.hhGastadas)),
                    itemStyle: { borderRadius: [2, 2, 0, 0], color: '#6366f1' },
                    label: {
                        backgroundColor: 'rgba(255,255,255,0.85)',
                        borderRadius: 3,
                        color: '#1e3a8a',
                        fontSize: 10,
                        fontWeight: 'bold',
                        formatter: (params: { value: number }) =>
                            formatBarK(params.value),
                        padding: [2, 4],
                        position: 'insideTop',
                        show: true,
                    },
                    name: 'HH GASTADAS',
                    type: 'bar',
                },
                {
                    data: aggregatedWeekly.map((p) =>
                        Number(p.pfSem.toFixed(2)),
                    ),
                    itemStyle: { color: '#b91c1c' },
                    label: {
                        backgroundColor: '#b91c1c',
                        borderRadius: 4,
                        color: '#ffffff',
                        fontSize: 10,
                        fontWeight: 'bold',
                        padding: [2, 5],
                        position: 'top',
                        show: true,
                    },
                    lineStyle: { width: 2.5 },
                    name: 'PF Actual',
                    smooth: true,
                    symbolSize: 6,
                    type: 'line',
                    yAxisIndex: 1,
                },
                {
                    data: aggregatedWeekly.map((p) =>
                        Number(p.pfAcum.toFixed(2)),
                    ),
                    itemStyle: { color: '#1e40af' },
                    label: {
                        backgroundColor: '#1e40af',
                        borderRadius: 4,
                        color: '#ffffff',
                        fontSize: 10,
                        fontWeight: 'bold',
                        padding: [2, 5],
                        position: 'bottom',
                        show: true,
                    },
                    lineStyle: { width: 2.5 },
                    name: 'PF Acumulado',
                    smooth: true,
                    symbolSize: 6,
                    type: 'line',
                    yAxisIndex: 1,
                },
            ],
            tooltip: { trigger: 'axis' },
            xAxis: { data: xLabels, type: 'category' },
            yAxis: [
                { name: 'HH', type: 'value' },
                { max: y2Max, min: y2Min, name: 'PF', type: 'value' },
            ],
        };
    }, [aggregatedWeekly]);

    const toggleDiscipline = (disc: string) => {
        setSelectedDisciplines((prev) =>
            prev.includes(disc)
                ? prev.filter((d) => d !== disc)
                : [...prev, disc],
        );
    };

    const currentCardPayload = (): OverviewCardItem => ({
        exploreName:
            dataset?.sourceExplores[0]?.exploreName ??
            'analitica_avance_horas_semana',
        id: `pbi-isp-${pbiView}`,
        metadata: {
            title: 'INFORME SEMANAL DE PRODUCCIÓN (ISP)',
        },
        mode: 'bar',
        preview: buildSyntheticComboPreview(aggregatedWeekly),
        tab: 'tracking',
        title: 'INFORME SEMANAL DE PRODUCCIÓN (ISP)',
    });

    if (loadingExplores || (loadingData && !dataset)) {
        return <EmptyStateLoader title="Cargando Informe Semanal ISP…" />;
    }

    if (exploresError || loadErr) {
        const errMsg =
            loadErr ??
            (exploresError instanceof Error ? exploresError.message : 'Error');
        return <InlineErrorState message={errMsg} />;
    }

    return (
        <div className={classes.root} data-testid="agent-bi-overview-board">
            <div className={classes.pbiHeader}>
                <div className={classes.pbiTitleBlock}>
                    <Text className={classes.pbiTitle}>
                        {locale === 'en'
                            ? 'WEEKLY PRODUCTION REPORT (ISP)'
                            : 'INFORME SEMANAL DE PRODUCCIÓN (ISP)'}
                    </Text>
                    <Text className={classes.pbiSubtitle}>
                        {selectedWeek === 'ALL'
                            ? `${dataset?.weeks.length ?? 0} semanas · Fuente: bronze`
                            : `Corte semana: ${selectedWeek}`}
                    </Text>
                </div>
                <Group gap="xs" wrap="wrap">
                    {(
                        [
                            ['inicio', 'Inicio'],
                            ['sin_factor', 'AS sin factor'],
                            ['pf_diario', 'AS PF Diario'],
                            ['indicadores', 'AS Indicadores'],
                        ] as const
                    ).map(([key, label]) => (
                        <Button
                            key={key}
                            size="compact-xs"
                            variant={pbiView === key ? 'white' : 'subtle'}
                            color={pbiView === key ? 'indigo' : 'gray'}
                            onClick={() => setPbiView(key)}
                        >
                            {label}
                        </Button>
                    ))}
                    <Button
                        size="compact-xs"
                        variant="light"
                        color="cyan"
                        leftSection={<IconFocus2 size={14} />}
                        onClick={() => onFocusCard(currentCardPayload())}
                    >
                        Enfocar y explicar
                    </Button>
                    <Button
                        size="compact-xs"
                        variant="light"
                        color="teal"
                        leftSection={<IconPin size={14} />}
                        onClick={() => onPinCard(currentCardPayload())}
                    >
                        Enviar al espacio
                    </Button>
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="gray"
                        aria-label="Actualizar"
                        onClick={() => setRefreshTick((n) => n + 1)}
                    >
                        <IconRefresh size={14} />
                    </ActionIcon>
                </Group>
            </div>

            <div className={classes.slicerRow}>
                <div className={classes.slicerCard}>
                    <div className={classes.slicerLabel}>SEMANA</div>
                    <Select
                        size="xs"
                        aria-label="Semana"
                        value={selectedWeek}
                        onChange={(v) => setSelectedWeek(v ?? 'ALL')}
                        data={[
                            { label: 'Todas', value: 'ALL' },
                            ...(dataset?.weeks ?? []).map((w) => ({
                                label: w,
                                value: w,
                            })),
                        ]}
                    />
                </div>
                <div className={classes.slicerCard}>
                    <div className={classes.slicerLabel}>ÁREA</div>
                    <Group gap={4} wrap="wrap">
                        <button
                            type="button"
                            className={
                                selectedArea === 'ALL'
                                    ? classes.areaTileActive
                                    : classes.areaTile
                            }
                            onClick={() => setSelectedArea('ALL')}
                        >
                            Todas
                        </button>
                        {(dataset?.areas ?? []).slice(0, 10).map((area) => (
                            <button
                                key={area}
                                type="button"
                                className={
                                    selectedArea === area
                                        ? classes.areaTileActive
                                        : classes.areaTile
                                }
                                onClick={() =>
                                    setSelectedArea((prev) =>
                                        prev === area ? 'ALL' : area,
                                    )
                                }
                            >
                                {area}
                            </button>
                        ))}
                    </Group>
                </div>
                <div className={classes.slicerCard}>
                    <div className={classes.slicerLabel}>FRENTE</div>
                    <Group gap={4} wrap="wrap">
                        <button
                            type="button"
                            className={
                                selectedFrente === 'ALL'
                                    ? classes.frenteTileActive
                                    : classes.frenteTile
                            }
                            onClick={() => setSelectedFrente('ALL')}
                        >
                            Todos
                        </button>
                        {(dataset?.frentes ?? []).map((fr) => (
                            <button
                                key={fr}
                                type="button"
                                className={
                                    selectedFrente === fr
                                        ? classes.frenteTileActive
                                        : classes.frenteTile
                                }
                                onClick={() =>
                                    setSelectedFrente((prev) =>
                                        prev === fr ? 'ALL' : fr,
                                    )
                                }
                            >
                                {fr}
                            </button>
                        ))}
                    </Group>
                </div>
            </div>

            <div className={classes.mainSplit}>
                <Stack gap="sm">
                    <div className={classes.kpiGrid}>
                        <div className={classes.kpiCard}>
                            <div className={classes.kpiHeaderBlue}>
                                HH Gan. Semanal
                            </div>
                            <div className={classes.kpiValue}>
                                {formatCompactNumber(kpis.hhGanSem)}
                            </div>
                        </div>
                        <div className={classes.kpiCard}>
                            <div className={classes.kpiHeaderBlue}>
                                HH Gast. Semanal
                            </div>
                            <div className={classes.kpiValue}>
                                {formatCompactNumber(kpis.hhGastSem)}
                            </div>
                        </div>
                        <div className={classes.kpiCard}>
                            <div className={classes.kpiHeaderBlue}>
                                PF Semanal
                            </div>
                            <div className={classes.kpiValue}>
                                {formatDecimal(kpis.pfSem)}
                            </div>
                        </div>
                        <div className={classes.kpiCard}>
                            <div className={classes.kpiHeaderPurple}>
                                HH Gan. Acumulado
                            </div>
                            <div className={classes.kpiValuePurple}>
                                {formatCompactNumber(kpis.hhGanAcum)}
                            </div>
                        </div>
                        <div className={classes.kpiCard}>
                            <div className={classes.kpiHeaderPurple}>
                                HH Gast. Acumulado
                            </div>
                            <div className={classes.kpiValuePurple}>
                                {formatCompactNumber(kpis.hhGastAcum)}
                            </div>
                        </div>
                        <div className={classes.kpiCard}>
                            <div className={classes.kpiHeaderPurple}>
                                PF Acumulado
                            </div>
                            <div className={classes.kpiValuePurple}>
                                {formatDecimal(kpis.pfAcum)}
                            </div>
                        </div>
                    </div>

                    <div className={classes.chartPanel}>
                        <div className={classes.chartPanelBar}>
                            <Text className={classes.chartPanelTitle}>
                                PF: HH DIRECTAS + AFECTACIÓN CLIMA (
                                {pbiView.toUpperCase()})
                            </Text>
                        </div>
                        <EChartsReact
                            option={comboChartOption}
                            notMerge
                            lazyUpdate
                        />
                    </div>

                    <div className={classes.matrixPanel}>
                        <div className={classes.matrixTableWrap}>
                            <Table
                                striped
                                highlightOnHover
                                withTableBorder
                                withColumnBorders
                                fz="xs"
                            >
                                <Table.Thead>
                                    <Table.Tr
                                        className={classes.matrixHeaderRow}
                                    >
                                        <Table.Th>
                                            Área / Disciplina / Commoditie
                                        </Table.Th>
                                        <Table.Th>Cant. Físico Sem.</Table.Th>
                                        <Table.Th>HH Gastadas Semana</Table.Th>
                                        <Table.Th>HH Ganadas Semana</Table.Th>
                                        <Table.Th>PF Semana</Table.Th>
                                        <Table.Th>MOD Sem.</Table.Th>
                                        <Table.Th>
                                            HH Gastadas Acumulado
                                        </Table.Th>
                                        <Table.Th>
                                            HH Ganadas Acumulado
                                        </Table.Th>
                                        <Table.Th>PF Acum.</Table.Th>
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    {groupedMatrix.map((grp) => {
                                        const isOpen = Boolean(
                                            expandedAreas[grp.area],
                                        );
                                        return (
                                            <>
                                                <Table.Tr
                                                    key={grp.area}
                                                    className={
                                                        classes.matrixParentRow
                                                    }
                                                >
                                                    <Table.Td>
                                                        <Button
                                                            size="compact-xs"
                                                            variant="subtle"
                                                            color="dark"
                                                            leftSection={
                                                                isOpen ? (
                                                                    <IconChevronDown
                                                                        size={
                                                                            12
                                                                        }
                                                                    />
                                                                ) : (
                                                                    <IconChevronRight
                                                                        size={
                                                                            12
                                                                        }
                                                                    />
                                                                )
                                                            }
                                                            onClick={() =>
                                                                setExpandedAreas(
                                                                    (prev) => ({
                                                                        ...prev,
                                                                        [grp.area]:
                                                                            !prev[
                                                                                grp
                                                                                    .area
                                                                            ],
                                                                    }),
                                                                )
                                                            }
                                                        >
                                                            {grp.area}
                                                        </Button>
                                                    </Table.Td>
                                                    <Table.Td>
                                                        {formatCompactNumber(
                                                            grp.cantFisicoSem,
                                                        )}
                                                    </Table.Td>
                                                    <Table.Td>
                                                        {formatCompactNumber(
                                                            grp.hhGastadasSem,
                                                        )}
                                                    </Table.Td>
                                                    <Table.Td>
                                                        {formatCompactNumber(
                                                            grp.hhGanadasSem,
                                                        )}
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <span
                                                            className={pfDotClass(
                                                                grp.pfSem,
                                                            )}
                                                        />
                                                        {formatDecimal(
                                                            grp.pfSem,
                                                        )}
                                                    </Table.Td>
                                                    <Table.Td>
                                                        {grp.modSem}
                                                    </Table.Td>
                                                    <Table.Td>
                                                        {formatCompactNumber(
                                                            grp.hhGastadasAcum,
                                                        )}
                                                    </Table.Td>
                                                    <Table.Td>
                                                        {formatCompactNumber(
                                                            grp.hhGanadasAcum,
                                                        )}
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <span
                                                            className={pfDotClass(
                                                                grp.pfAcum,
                                                            )}
                                                        />
                                                        {formatDecimal(
                                                            grp.pfAcum,
                                                        )}
                                                    </Table.Td>
                                                </Table.Tr>
                                                {isOpen &&
                                                    grp.children.map((ch) => (
                                                        <Table.Tr key={ch.id}>
                                                            <Table.Td pl="xl">
                                                                {ch.disciplina}{' '}
                                                                ·{' '}
                                                                {ch.commoditie}
                                                            </Table.Td>
                                                            <Table.Td>
                                                                {formatCompactNumber(
                                                                    ch.cantFisicoSem,
                                                                )}
                                                            </Table.Td>
                                                            <Table.Td>
                                                                {formatCompactNumber(
                                                                    ch.hhGastadasSem,
                                                                )}
                                                            </Table.Td>
                                                            <Table.Td>
                                                                {formatCompactNumber(
                                                                    ch.hhGanadasSem,
                                                                )}
                                                            </Table.Td>
                                                            <Table.Td>
                                                                <span
                                                                    className={pfDotClass(
                                                                        ch.pfSem,
                                                                    )}
                                                                />
                                                                {formatDecimal(
                                                                    ch.pfSem,
                                                                )}
                                                            </Table.Td>
                                                            <Table.Td>
                                                                {ch.modSem}
                                                            </Table.Td>
                                                            <Table.Td>
                                                                {formatCompactNumber(
                                                                    ch.hhGastadasAcum,
                                                                )}
                                                            </Table.Td>
                                                            <Table.Td>
                                                                {formatCompactNumber(
                                                                    ch.hhGanadasAcum,
                                                                )}
                                                            </Table.Td>
                                                            <Table.Td>
                                                                <span
                                                                    className={pfDotClass(
                                                                        ch.pfAcum,
                                                                    )}
                                                                />
                                                                {formatDecimal(
                                                                    ch.pfAcum,
                                                                )}
                                                            </Table.Td>
                                                        </Table.Tr>
                                                    ))}
                                            </>
                                        );
                                    })}
                                    <Table.Tr
                                        className={classes.matrixTotalRow}
                                    >
                                        <Table.Td>Total</Table.Td>
                                        <Table.Td>—</Table.Td>
                                        <Table.Td>
                                            {formatCompactNumber(
                                                groupedMatrix.reduce(
                                                    (s, g) =>
                                                        s + g.hhGastadasSem,
                                                    0,
                                                ),
                                            )}
                                        </Table.Td>
                                        <Table.Td>
                                            {formatCompactNumber(
                                                groupedMatrix.reduce(
                                                    (s, g) =>
                                                        s + g.hhGanadasSem,
                                                    0,
                                                ),
                                            )}
                                        </Table.Td>
                                        <Table.Td>
                                            {formatDecimal(kpis.pfSem)}
                                        </Table.Td>
                                        <Table.Td>
                                            {groupedMatrix.reduce(
                                                (s, g) => s + g.modSem,
                                                0,
                                            )}
                                        </Table.Td>
                                        <Table.Td>
                                            {formatCompactNumber(
                                                groupedMatrix.reduce(
                                                    (s, g) =>
                                                        s + g.hhGastadasAcum,
                                                    0,
                                                ),
                                            )}
                                        </Table.Td>
                                        <Table.Td>
                                            {formatCompactNumber(
                                                groupedMatrix.reduce(
                                                    (s, g) =>
                                                        s + g.hhGanadasAcum,
                                                    0,
                                                ),
                                            )}
                                        </Table.Td>
                                        <Table.Td>
                                            {formatDecimal(kpis.pfAcum)}
                                        </Table.Td>
                                    </Table.Tr>
                                </Table.Tbody>
                            </Table>
                        </div>
                    </div>
                </Stack>

                <div className={classes.disciplinePanel}>
                    <Group justify="space-between" mb="xs">
                        <Text className={classes.slicerLabel}>DISCIPLINA</Text>
                        {selectedDisciplines.length > 0 ? (
                            <Button
                                size="compact-xs"
                                variant="subtle"
                                onClick={() => setSelectedDisciplines([])}
                            >
                                Todas
                            </Button>
                        ) : null}
                    </Group>
                    <Stack gap={6}>
                        {(dataset?.disciplinas ?? []).map((disc) => (
                            <Checkbox
                                key={disc}
                                size="xs"
                                label={disc}
                                checked={selectedDisciplines.includes(disc)}
                                onChange={() => toggleDiscipline(disc)}
                            />
                        ))}
                    </Stack>
                </div>
            </div>
        </div>
    );
};

export default AgentBiOverviewBoard;
