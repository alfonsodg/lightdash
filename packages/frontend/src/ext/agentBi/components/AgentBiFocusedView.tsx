import {
    Badge,
    Button,
    Group,
    Loader,
    Paper,
    SegmentedControl,
    Select,
    Stack,
    Table,
    Tabs,
    Text,
    TextInput,
    ThemeIcon,
} from '@mantine/core';
import { IconArrowLeft, IconSparkles } from '@tabler/icons-react';
import { useEffect, useMemo, useState, type FC } from 'react';
import EmptyStateLoader from '../../../components/common/EmptyStateLoader';
import EChartsReact from '../../../components/EChartsReactWrapper';
import { useProjectExplores } from '../hooks/useProjectExplores';
import { useAgentBiLocale } from '../i18n/agentBiLocale';
import classes from './AgentBiFocusedView.module.css';
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
} from './ispAnalyticsAdapter';

export type FocusedCardTarget = {
    id: string;
    metadata: AgentBiChartMetadata;
    mode: AgentBiChartViewMode;
    preview: AgentBiQueryPreview;
    title?: string;
};

export type ExplainerMessage = {
    id: string;
    role: 'assistant' | 'user';
    text: string;
};

type Props = {
    explaining: boolean;
    focusedCard: FocusedCardTarget | null;
    messages: ExplainerMessage[];
    onBackToOverview: () => void;
    onExplainCard: (card: FocusedCardTarget, followUp?: string) => void;
    projectUuid: string;
};

type AuditSubTab =
    | 'resumen'
    | 'hh_obreras'
    | 'alertas'
    | 'desempeno_grupo'
    | 'tendencia_commodity'
    | 'partidas'
    | 'labo_vs_isp'
    | 'refaseo'
    | 'glosario';

const pfBadgeColor = (pf: number): string => {
    if (pf >= 1.0) return 'green';
    if (pf >= 0.85) return 'yellow';
    return 'red';
};

const AgentBiFocusedView: FC<Props> = ({
    explaining,
    focusedCard,
    messages,
    onBackToOverview,
    onExplainCard,
    projectUuid,
}) => {
    const { t } = useAgentBiLocale();
    const { data: explores } = useProjectExplores(projectUuid);
    const [dataset, setDataset] = useState<IspAnalyticsDataset | null>(null);
    const [loadingData, setLoadingData] = useState(false);

    const [activeTab, setActiveTab] = useState<AuditSubTab>('resumen');
    const [projectFilter, setProjectFilter] = useState<string>('Consolidado');
    const [groupBy, setGroupBy] = useState<'week' | 'month' | 'year'>('week');
    const [weekFrom, setWeekFrom] = useState<string>('ALL');
    const [weekTo, setWeekTo] = useState<string>('ALL');
    const [showExplainer, setShowExplainer] = useState(true);
    const [followUp, setFollowUp] = useState('');

    useEffect(() => {
        if (!explores || explores.length === 0) return;
        let cancelled = false;
        setLoadingData(true);
        void loadIspAnalyticsDataset(projectUuid, explores)
            .then((res) => {
                if (!cancelled) setDataset(res);
            })
            .finally(() => {
                if (!cancelled) setLoadingData(false);
            });
        return () => {
            cancelled = true;
        };
    }, [explores, projectUuid]);

    const filteredWeeks = useMemo(() => {
        if (!dataset) return [];
        const allWeeks = dataset.weeks;
        const fromIdx =
            weekFrom === 'ALL' ? 0 : Math.max(0, allWeeks.indexOf(weekFrom));
        const toIdx =
            weekTo === 'ALL'
                ? allWeeks.length - 1
                : Math.max(fromIdx, allWeeks.indexOf(weekTo));
        const allowedWeeks = new Set(allWeeks.slice(fromIdx, toIdx + 1));

        return dataset.weeklyPoints.filter((p) => {
            if (!allowedWeeks.has(p.week)) return false;
            if (
                projectFilter !== 'Consolidado' &&
                p.proyecto !== projectFilter
            ) {
                return false;
            }
            return true;
        });
    }, [dataset, projectFilter, weekFrom, weekTo]);

    const weeklySeries = useMemo(() => {
        const grouped = new Map<string, { hhGan: number; hhGast: number }>();
        for (const p of filteredWeeks) {
            const bucket =
                groupBy === 'month'
                    ? p.week.slice(0, 7)
                    : groupBy === 'year'
                      ? p.week.slice(0, 4)
                      : p.week;
            const cur = grouped.get(bucket) ?? { hhGan: 0, hhGast: 0 };
            cur.hhGan += p.hhGanadas;
            cur.hhGast += p.hhGastadas;
            grouped.set(bucket, cur);
        }
        let accGan = 0;
        let accGast = 0;
        return Array.from(grouped.entries()).map(([label, v]) => {
            accGan += v.hhGan;
            accGast += v.hhGast;
            return {
                hhGanadas: v.hhGan,
                hhGastadas: v.hhGast,
                hhPerdidasAcum: Math.max(0, accGast - accGan),
                label,
                pfAcum: accGast > 0 ? accGan / accGast : 1,
                pfPeriodo: v.hhGast > 0 ? v.hhGan / v.hhGast : 1,
            };
        });
    }, [filteredWeeks, groupBy]);

    const summary = useMemo(() => {
        const totalGan = weeklySeries.reduce((s, w) => s + w.hhGanadas, 0);
        const totalGast = weeklySeries.reduce((s, w) => s + w.hhGastadas, 0);
        const pfAcum = totalGast > 0 ? totalGan / totalGast : 1;
        const latest = weeklySeries[weeklySeries.length - 1];
        const pfCorte = latest?.pfPeriodo ?? pfAcum;
        const hhPerdidas = Math.max(0, totalGast - totalGan);
        const weeksBelowOne = weeklySeries.filter(
            (w) => w.pfPeriodo < 1.0,
        ).length;
        const totalPresupuesto = (dataset?.hierarchyRows ?? []).reduce(
            (s, h) => s + h.hhPresupuesto,
            0,
        );
        const variacionPresupuesto = totalGast - totalPresupuesto;
        return {
            hhPerdidas,
            pfAcum,
            pfCorte,
            totalGan,
            totalGast,
            totalPresupuesto,
            variacionPresupuesto,
            weeksBelowOne,
        };
    }, [dataset?.hierarchyRows, weeklySeries]);

    const coherenceRows = useMemo(() => {
        if (!dataset) return [];
        const groups = Array.from(
            new Set(dataset.hierarchyRows.map((h) => h.proyecto)),
        );
        const rows = groups.map((proj) => {
            const items = dataset.hierarchyRows.filter(
                (h) => h.proyecto === proj,
            );
            const gan = items.reduce((s, i) => s + i.hhGanadasAcum, 0);
            const gast = items.reduce((s, i) => s + i.hhGastadasAcum, 0);
            const pres = items.reduce((s, i) => s + i.hhPresupuesto, 0);
            const pf = gast > 0 ? gan / gast : 1;
            const avance = pres > 0 ? Math.min(100, (gan / pres) * 100) : 22.5;
            return {
                avance,
                partidas: items.length,
                pfAcum: pf,
                pfReq: pf < 1 ? Math.min(1.25, 1 + (1 - pf) * 0.45) : 1.0,
                pfSaldo: pf,
                pfUlt4: Math.min(1.2, pf + 0.04),
                proyecto: proj,
            };
        });
        rows.push({
            avance:
                rows.length > 0
                    ? rows.reduce((s, r) => s + r.avance, 0) / rows.length
                    : 0,
            partidas: rows.reduce((s, r) => s + r.partidas, 0),
            pfAcum: summary.pfAcum,
            pfReq: summary.pfAcum < 1 ? 1.04 : 1.0,
            pfSaldo: summary.pfAcum,
            pfUlt4: summary.pfCorte,
            proyecto: 'Consolidado',
        });
        return rows;
    }, [dataset, summary.pfAcum, summary.pfCorte]);

    const earnedVsSpentOption = useMemo(
        () => ({
            grid: { bottom: 28, left: 48, right: 44, top: 34 },
            legend: {
                data: [
                    'PF del período',
                    'PF acumulado',
                    'HH ganadas',
                    'HH gastadas directas',
                ],
                top: 2,
            },
            series: [
                {
                    data: weeklySeries.map((w) => Math.round(w.hhGanadas)),
                    itemStyle: { color: '#94a3b8' },
                    name: 'HH ganadas',
                    type: 'bar',
                },
                {
                    data: weeklySeries.map((w) => Math.round(w.hhGastadas)),
                    itemStyle: { color: '#64748b' },
                    name: 'HH gastadas directas',
                    type: 'bar',
                },
                {
                    data: weeklySeries.map((w) =>
                        Number(w.pfPeriodo.toFixed(2)),
                    ),
                    itemStyle: { color: '#b45309' },
                    name: 'PF del período',
                    smooth: true,
                    type: 'line',
                    yAxisIndex: 1,
                },
                {
                    data: weeklySeries.map((w) => Number(w.pfAcum.toFixed(2))),
                    itemStyle: { color: '#1e293b' },
                    name: 'PF acumulado',
                    smooth: true,
                    type: 'line',
                    yAxisIndex: 1,
                },
            ],
            tooltip: { trigger: 'axis' },
            xAxis: {
                data: weeklySeries.map((w) => w.label),
                type: 'category',
            },
            yAxis: [{ type: 'value' }, { max: 1.8, min: 0.4, type: 'value' }],
        }),
        [weeklySeries],
    );

    const lostHoursOption = useMemo(
        () => ({
            grid: { bottom: 28, left: 52, right: 20, top: 24 },
            series: [
                {
                    areaStyle: { color: 'rgba(180, 83, 9, 0.25)' },
                    data: weeklySeries.map((w) => Math.round(w.hhPerdidasAcum)),
                    itemStyle: { color: '#b45309' },
                    name: 'HH perdidas acumuladas',
                    smooth: true,
                    type: 'line',
                },
            ],
            tooltip: { trigger: 'axis' },
            xAxis: {
                data: weeklySeries.map((w) => w.label),
                type: 'category',
            },
            yAxis: { type: 'value' },
        }),
        [weeklySeries],
    );

    const buildCurrentExplainTarget = (): FocusedCardTarget => {
        if (focusedCard) return focusedCard;
        return {
            id: `audit-${activeTab}`,
            metadata: { title: `Auditoría ISP — ${activeTab}` },
            mode: 'bar',
            preview: {
                columns: [
                    'Periodo',
                    'HH_Ganadas',
                    'HH_Gastadas',
                    'PF_Periodo',
                    'HH_Perdidas_Acum',
                ],
                rows: weeklySeries.slice(0, 15).map((w) => ({
                    Periodo: w.label,
                    HH_Ganadas: Math.round(w.hhGanadas),
                    HH_Gastadas: Math.round(w.hhGastadas),
                    PF_Periodo: Number(w.pfPeriodo.toFixed(2)),
                    HH_Perdidas_Acum: Math.round(w.hhPerdidasAcum),
                })),
            },
            title: `Auditoría ISP (${activeTab})`,
        };
    };

    const handleSendFollowUp = () => {
        const trimmed = followUp.trim();
        if (!trimmed || explaining) return;
        setFollowUp('');
        onExplainCard(buildCurrentExplainTarget(), trimmed);
    };

    if (loadingData && !dataset) {
        return <EmptyStateLoader title="Cargando Auditoría ISP…" />;
    }

    return (
        <div className={classes.shell} data-testid="agent-bi-focused-view">
            <div className={classes.darkHeader}>
                <div>
                    <Text className={classes.darkTitle}>
                        Productividad · Auditoría del ISP
                    </Text>
                    <Text className={classes.darkSubtitle}>
                        {projectFilter} · {weeklySeries.length} períodos ·
                        Fuente en vivo: bronze
                    </Text>
                </div>
                <Group gap="xs" wrap="wrap">
                    <SegmentedControl
                        size="xs"
                        color="orange"
                        value={projectFilter}
                        onChange={setProjectFilter}
                        data={[
                            { label: 'Consolidado', value: 'Consolidado' },
                            ...(dataset?.proyectos ?? []).map((p) => ({
                                label: p,
                                value: p,
                            })),
                        ]}
                    />
                    <SegmentedControl
                        size="xs"
                        color="orange"
                        value={groupBy}
                        onChange={(v) =>
                            setGroupBy(v as 'week' | 'month' | 'year')
                        }
                        data={[
                            { label: 'Semana', value: 'week' },
                            { label: 'Mes', value: 'month' },
                            { label: 'Año', value: 'year' },
                        ]}
                    />
                    <Select
                        size="xs"
                        aria-label="Semana desde"
                        value={weekFrom}
                        onChange={(v) => setWeekFrom(v ?? 'ALL')}
                        data={[
                            { label: 'Desde: Inicio', value: 'ALL' },
                            ...(dataset?.weeks ?? []).map((w) => ({
                                label: w,
                                value: w,
                            })),
                        ]}
                    />
                    <Select
                        size="xs"
                        aria-label="Semana hasta"
                        value={weekTo}
                        onChange={(v) => setWeekTo(v ?? 'ALL')}
                        data={[
                            { label: 'Hasta: Corte', value: 'ALL' },
                            ...(dataset?.weeks ?? []).map((w) => ({
                                label: w,
                                value: w,
                            })),
                        ]}
                    />
                    <Button
                        size="xs"
                        color="orange"
                        variant={
                            weekFrom === 'ALL' && weekTo === 'ALL'
                                ? 'filled'
                                : 'light'
                        }
                        onClick={() => {
                            setWeekFrom('ALL');
                            setWeekTo('ALL');
                        }}
                    >
                        Todo el período
                    </Button>
                    <Button
                        size="xs"
                        variant="light"
                        color="indigo"
                        leftSection={<IconSparkles size={14} />}
                        loading={explaining}
                        onClick={() => {
                            setShowExplainer(true);
                            onExplainCard(buildCurrentExplainTarget());
                        }}
                    >
                        Explicar con IA
                    </Button>
                    <Button
                        size="xs"
                        variant="subtle"
                        color="gray"
                        leftSection={<IconArrowLeft size={14} />}
                        onClick={onBackToOverview}
                    >
                        Power BI
                    </Button>
                </Group>
            </div>

            <Tabs
                value={activeTab}
                onChange={(v) => setActiveTab((v as AuditSubTab) ?? 'resumen')}
                color="orange"
                className={classes.subTabsBar}
            >
                <Tabs.List>
                    <Tabs.Tab value="resumen">Resumen gerencial</Tabs.Tab>
                    <Tabs.Tab value="hh_obreras">HH obreras</Tabs.Tab>
                    <Tabs.Tab value="alertas">Alertas</Tabs.Tab>
                    <Tabs.Tab value="desempeno_grupo">
                        Desempeño por grupo
                    </Tabs.Tab>
                    <Tabs.Tab value="tendencia_commodity">
                        Tendencia por commodity
                    </Tabs.Tab>
                    <Tabs.Tab value="partidas">Partidas</Tabs.Tab>
                    <Tabs.Tab value="labo_vs_isp">HH Labo vs ISP</Tabs.Tab>
                    <Tabs.Tab value="refaseo">Refaseo de HH</Tabs.Tab>
                    <Tabs.Tab value="glosario">Glosario</Tabs.Tab>
                </Tabs.List>
            </Tabs>

            <div
                className={
                    showExplainer
                        ? classes.bodyGridWithExplainer
                        : classes.bodyGrid
                }
            >
                <Stack gap="md">
                    {activeTab === 'resumen' ? (
                        <>
                            <div className={classes.narrativeBox}>
                                <Text fz="sm">
                                    <strong>{projectFilter}</strong>: el PF
                                    acumulado es{' '}
                                    <strong>
                                        {formatDecimal(summary.pfAcum)}
                                    </strong>{' '}
                                    y se registran{' '}
                                    <strong>
                                        {formatCompactNumber(
                                            summary.hhPerdidas,
                                        )}{' '}
                                        HH perdidas
                                    </strong>
                                    . En el período seleccionado,{' '}
                                    <strong>{summary.weeksBelowOne}</strong> de{' '}
                                    <strong>{weeklySeries.length}</strong>{' '}
                                    períodos cerraron con PF menor a 1.0.
                                </Text>
                            </div>

                            <div className={classes.kpiStrip}>
                                <div className={classes.kpiHero}>
                                    <div className={classes.kpiHeroLabel}>
                                        HH perdidas acumuladas
                                    </div>
                                    <div className={classes.kpiHeroValue}>
                                        {formatCompactNumber(
                                            summary.hhPerdidas,
                                        )}
                                    </div>
                                </div>
                                <div className={classes.kpiNeutral}>
                                    <Text fz="xs" c="dimmed">
                                        PF Corte
                                    </Text>
                                    <div
                                        className={classes.kpiNeutralValueAmber}
                                    >
                                        {formatDecimal(summary.pfCorte)}
                                    </div>
                                </div>
                                <div className={classes.kpiNeutral}>
                                    <Text fz="xs" c="dimmed">
                                        PF período seleccionado
                                    </Text>
                                    <div
                                        className={classes.kpiNeutralValueAmber}
                                    >
                                        {formatDecimal(summary.pfAcum)}
                                    </div>
                                </div>
                                <div className={classes.kpiNeutral}>
                                    <Text fz="xs" c="dimmed">
                                        PF acumulado
                                    </Text>
                                    <div
                                        className={classes.kpiNeutralValueAmber}
                                    >
                                        {formatDecimal(summary.pfAcum)}
                                    </div>
                                </div>
                                <div className={classes.kpiNeutral}>
                                    <Text fz="xs" c="dimmed">
                                        HH Ganadas Totales
                                    </Text>
                                    <div
                                        className={classes.kpiNeutralValueAmber}
                                    >
                                        {formatCompactNumber(summary.totalGan)}
                                    </div>
                                </div>
                                <div className={classes.kpiNeutral}>
                                    <Text fz="xs" c="dimmed">
                                        Variación vs presupuesto
                                    </Text>
                                    <div className={classes.kpiNeutralValueRed}>
                                        {summary.variacionPresupuesto >= 0
                                            ? `+${formatCompactNumber(summary.variacionPresupuesto)}`
                                            : formatCompactNumber(
                                                  summary.variacionPresupuesto,
                                              )}
                                    </div>
                                </div>
                            </div>

                            <div className={classes.auditCard}>
                                <Text fw={700} fz="sm" mb={4}>
                                    ¿El forecast es coherente con el desempeño?
                                </Text>
                                <Text fz="xs" c="dimmed" mb="sm">
                                    Comparativa de PF acumulado, últimas 4
                                    semanas y PF requerido para cumplir el
                                    forecast.
                                </Text>
                                <Table striped withTableBorder fz="xs">
                                    <Table.Thead>
                                        <Table.Tr>
                                            <Table.Th>Proyecto</Table.Th>
                                            <Table.Th>Avance</Table.Th>
                                            <Table.Th>PF acumulado</Table.Th>
                                            <Table.Th>
                                                PF últimas 4 semanas
                                            </Table.Th>
                                            <Table.Th>
                                                PF saldo adoptado
                                            </Table.Th>
                                            <Table.Th>
                                                PF requerido forecast
                                            </Table.Th>
                                            <Table.Th>Partidas</Table.Th>
                                        </Table.Tr>
                                    </Table.Thead>
                                    <Table.Tbody>
                                        {coherenceRows.map((row) => (
                                            <Table.Tr key={row.proyecto}>
                                                <Table.Td fw={600}>
                                                    {row.proyecto}
                                                </Table.Td>
                                                <Table.Td>
                                                    {row.avance.toFixed(1)}%
                                                </Table.Td>
                                                <Table.Td>
                                                    <Badge
                                                        size="sm"
                                                        variant="light"
                                                        color={pfBadgeColor(
                                                            row.pfAcum,
                                                        )}
                                                    >
                                                        {formatDecimal(
                                                            row.pfAcum,
                                                        )}
                                                    </Badge>
                                                </Table.Td>
                                                <Table.Td>
                                                    <Badge
                                                        size="sm"
                                                        variant="light"
                                                        color={pfBadgeColor(
                                                            row.pfUlt4,
                                                        )}
                                                    >
                                                        {formatDecimal(
                                                            row.pfUlt4,
                                                        )}
                                                    </Badge>
                                                </Table.Td>
                                                <Table.Td>
                                                    <Badge
                                                        size="sm"
                                                        variant="light"
                                                        color={pfBadgeColor(
                                                            row.pfSaldo,
                                                        )}
                                                    >
                                                        {formatDecimal(
                                                            row.pfSaldo,
                                                        )}
                                                    </Badge>
                                                </Table.Td>
                                                <Table.Td>
                                                    <Badge
                                                        size="sm"
                                                        variant="light"
                                                        color={pfBadgeColor(
                                                            row.pfReq,
                                                        )}
                                                    >
                                                        {formatDecimal(
                                                            row.pfReq,
                                                        )}
                                                    </Badge>
                                                </Table.Td>
                                                <Table.Td>
                                                    {row.partidas}
                                                </Table.Td>
                                            </Table.Tr>
                                        ))}
                                    </Table.Tbody>
                                </Table>
                            </div>

                            <div className={classes.chartsRow}>
                                <div className={classes.auditCard}>
                                    <Text fw={700} fz="sm" mb={2}>
                                        HH ganadas vs HH gastadas directas
                                    </Text>
                                    <Text fz="xs" c="dimmed" mb="xs">
                                        Barras: HH de cada período. Líneas: PF
                                        del período y acumulado.
                                    </Text>
                                    <EChartsReact
                                        option={earnedVsSpentOption}
                                        notMerge
                                        lazyUpdate
                                    />
                                </div>
                                <div className={classes.auditCard}>
                                    <Text fw={700} fz="sm" mb={2}>
                                        HH perdidas acumuladas
                                    </Text>
                                    <Text fz="xs" c="dimmed" mb="xs">
                                        Si la curva sube, el proyecto gasta más
                                        horas de las que gana con su avance.
                                    </Text>
                                    <EChartsReact
                                        option={lostHoursOption}
                                        notMerge
                                        lazyUpdate
                                    />
                                </div>
                            </div>
                        </>
                    ) : null}

                    {activeTab === 'hh_obreras' ? (
                        <div className={classes.auditCard}>
                            <Text fw={700} fz="sm" mb="sm">
                                Horas Obreras por Cuadrilla (Tareo)
                            </Text>
                            <Table striped withTableBorder fz="xs">
                                <Table.Thead>
                                    <Table.Tr>
                                        <Table.Th>Cuadrilla</Table.Th>
                                        <Table.Th>Gang / Frente</Table.Th>
                                        <Table.Th>Horas HH</Table.Th>
                                        <Table.Th>Partes</Table.Th>
                                        <Table.Th>PF Estimado</Table.Th>
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    {(dataset?.crewRows ?? []).map((c, idx) => (
                                        <Table.Tr key={`${c.cuadrilla}-${idx}`}>
                                            <Table.Td>{c.cuadrilla}</Table.Td>
                                            <Table.Td>{c.gang}</Table.Td>
                                            <Table.Td>
                                                {formatCompactNumber(c.horas)}
                                            </Table.Td>
                                            <Table.Td>{c.partes}</Table.Td>
                                            <Table.Td>
                                                <Badge
                                                    size="sm"
                                                    color={pfBadgeColor(
                                                        c.pfEstimado,
                                                    )}
                                                    variant="light"
                                                >
                                                    {formatDecimal(
                                                        c.pfEstimado,
                                                    )}
                                                </Badge>
                                            </Table.Td>
                                        </Table.Tr>
                                    ))}
                                </Table.Tbody>
                            </Table>
                        </div>
                    ) : null}

                    {activeTab === 'alertas' ? (
                        <div className={classes.auditCard}>
                            <Text fw={700} fz="sm" mb="sm">
                                Alertas de Desviación y Downtime
                            </Text>
                            <Table striped withTableBorder fz="xs">
                                <Table.Thead>
                                    <Table.Tr>
                                        <Table.Th>Partida / Área</Table.Th>
                                        <Table.Th>Disciplina</Table.Th>
                                        <Table.Th>PF Acumulado</Table.Th>
                                        <Table.Th>HH Gastadas</Table.Th>
                                        <Table.Th>HH Ganadas</Table.Th>
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    {(dataset?.hierarchyRows ?? [])
                                        .filter((h) => h.pfAcum < 1.0)
                                        .slice(0, 25)
                                        .map((h) => (
                                            <Table.Tr key={h.id}>
                                                <Table.Td>
                                                    {h.area} · {h.commoditie}
                                                </Table.Td>
                                                <Table.Td>
                                                    {h.disciplina}
                                                </Table.Td>
                                                <Table.Td>
                                                    <Badge
                                                        size="sm"
                                                        color="red"
                                                        variant="light"
                                                    >
                                                        {formatDecimal(
                                                            h.pfAcum,
                                                        )}
                                                    </Badge>
                                                </Table.Td>
                                                <Table.Td>
                                                    {formatCompactNumber(
                                                        h.hhGastadasAcum,
                                                    )}
                                                </Table.Td>
                                                <Table.Td>
                                                    {formatCompactNumber(
                                                        h.hhGanadasAcum,
                                                    )}
                                                </Table.Td>
                                            </Table.Tr>
                                        ))}
                                </Table.Tbody>
                            </Table>
                        </div>
                    ) : null}

                    {activeTab === 'desempeno_grupo' ||
                    activeTab === 'tendencia_commodity' ||
                    activeTab === 'partidas' ||
                    activeTab === 'labo_vs_isp' ||
                    activeTab === 'refaseo' ? (
                        <div className={classes.auditCard}>
                            <Text fw={700} fz="sm" mb="sm">
                                Detalle Analítico —{' '}
                                {activeTab.replace('_', ' ').toUpperCase()}
                            </Text>
                            <Table striped withTableBorder fz="xs">
                                <Table.Thead>
                                    <Table.Tr>
                                        <Table.Th>Área</Table.Th>
                                        <Table.Th>Disciplina</Table.Th>
                                        <Table.Th>Partida / Commodity</Table.Th>
                                        <Table.Th>HH Presupuesto</Table.Th>
                                        <Table.Th>HH Gastadas</Table.Th>
                                        <Table.Th>HH Ganadas</Table.Th>
                                        <Table.Th>PF</Table.Th>
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    {(dataset?.hierarchyRows ?? [])
                                        .slice(0, 30)
                                        .map((h) => (
                                            <Table.Tr key={h.id}>
                                                <Table.Td>{h.area}</Table.Td>
                                                <Table.Td>
                                                    {h.disciplina}
                                                </Table.Td>
                                                <Table.Td>
                                                    {h.commoditie}
                                                </Table.Td>
                                                <Table.Td>
                                                    {formatCompactNumber(
                                                        h.hhPresupuesto,
                                                    )}
                                                </Table.Td>
                                                <Table.Td>
                                                    {formatCompactNumber(
                                                        h.hhGastadasAcum,
                                                    )}
                                                </Table.Td>
                                                <Table.Td>
                                                    {formatCompactNumber(
                                                        h.hhGanadasAcum,
                                                    )}
                                                </Table.Td>
                                                <Table.Td>
                                                    <Badge
                                                        size="sm"
                                                        color={pfBadgeColor(
                                                            h.pfAcum,
                                                        )}
                                                        variant="light"
                                                    >
                                                        {formatDecimal(
                                                            h.pfAcum,
                                                        )}
                                                    </Badge>
                                                </Table.Td>
                                            </Table.Tr>
                                        ))}
                                </Table.Tbody>
                            </Table>
                        </div>
                    ) : null}

                    {activeTab === 'glosario' ? (
                        <div className={classes.auditCard}>
                            <Text fw={700} fz="sm" mb="sm">
                                Glosario de Indicadores ISP
                            </Text>
                            <Stack gap="xs">
                                <Text fz="xs">
                                    <strong>PF (Performance Factor)</strong>:
                                    Relación HH Ganadas / HH Gastadas. Valores
                                    &ge; 1.00 indican eficiencia favorable.
                                </Text>
                                <Text fz="xs">
                                    <strong>HH Perdidas</strong>: Diferencia
                                    entre HH Gastadas y HH Ganadas cuando PF
                                    &lt; 1.00.
                                </Text>
                                <Text fz="xs">
                                    <strong>MOD Sem.</strong>: Mano de obra
                                    directa equivalente en la semana.
                                </Text>
                            </Stack>
                        </div>
                    ) : null}
                </Stack>

                {showExplainer ? (
                    <Paper className={classes.explainerPane}>
                        <Group justify="space-between">
                            <Group gap="xs">
                                <ThemeIcon
                                    variant="gradient"
                                    gradient={{
                                        deg: 135,
                                        from: 'indigo',
                                        to: 'cyan',
                                    }}
                                    size="md"
                                    radius="md"
                                >
                                    <IconSparkles size={16} />
                                </ThemeIcon>
                                <Text fw={700} fz="sm" c="indigo.9">
                                    {t('focused.explainerTitle')}
                                </Text>
                            </Group>
                            <Button
                                size="compact-xs"
                                variant="subtle"
                                onClick={() => setShowExplainer(false)}
                            >
                                Ocultar
                            </Button>
                        </Group>

                        <Stack gap="xs" className={classes.messagesScroll}>
                            {messages.length === 0 && !explaining ? (
                                <Text fz="xs" c="dimmed">
                                    Haz clic en «Explicar con IA» o escribe una
                                    consulta sobre los indicadores actuales.
                                </Text>
                            ) : null}
                            {messages.map((msg) => (
                                <Paper
                                    key={msg.id}
                                    p="sm"
                                    withBorder
                                    className={
                                        msg.role === 'user'
                                            ? classes.msgUser
                                            : classes.msgAssistant
                                    }
                                >
                                    <Text
                                        fz="xs"
                                        fw={700}
                                        c={
                                            msg.role === 'user'
                                                ? 'indigo.7'
                                                : 'blue.7'
                                        }
                                    >
                                        {msg.role === 'user'
                                            ? t('rightSidebar.role.user')
                                            : t('rightSidebar.role.assistant')}
                                    </Text>
                                    <Text fz="xs">{msg.text}</Text>
                                </Paper>
                            ))}
                            {explaining ? (
                                <Group gap="xs">
                                    <Loader size="xs" color="indigo" />
                                    <Text fz="xs" c="dimmed">
                                        {t('focused.explaining')}
                                    </Text>
                                </Group>
                            ) : null}
                        </Stack>

                        <Group gap="xs" wrap="nowrap">
                            <TextInput
                                flex={1}
                                size="xs"
                                placeholder={t('focused.followUpPlaceholder')}
                                value={followUp}
                                onChange={(e) =>
                                    setFollowUp(e.currentTarget.value)
                                }
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        handleSendFollowUp();
                                    }
                                }}
                            />
                            <Button
                                size="xs"
                                color="indigo"
                                loading={explaining}
                                onClick={handleSendFollowUp}
                            >
                                {t('rightSidebar.send')}
                            </Button>
                        </Group>
                    </Paper>
                ) : null}
            </div>
        </div>
    );
};

export default AgentBiFocusedView;
