import {
    FeatureFlags,
    isExploreError,
    NotFoundError,
    ParameterError,
} from '@lightdash/common';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import {
    allowApiKeyAuthentication,
    isAuthenticated,
} from '../controllers/authentication';

export interface ExploreFieldSummary {
    id: string;
    label: string;
    table: string;
    type: string;
}

export interface AgentBiExploreSummary {
    baseTable: string;
    dimensions: ExploreFieldSummary[];
    label: string;
    metrics: ExploreFieldSummary[];
    name: string;
}

const metricPreviewSchema = z.object({
    dimensions: z.array(z.string()).max(10).default([]),
    exploreName: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
    metrics: z.array(z.string()).max(10).default([]),
});

const requireFlagAndViewer = async (
    req: Request,
    projectUuid: string,
): Promise<void> => {
    const { enabled } = await req.services.getFeatureFlagService().get({
        user: req.user!,
        featureFlagId: FeatureFlags.AgentBi,
    });
    if (!enabled) {
        throw new NotFoundError('Not found');
    }
    await req.services
        .getAgentBiService()
        .requireProjectViewer(req.account!, projectUuid);
};

const unwrapCell = (cell: unknown): unknown => {
    if (
        typeof cell === 'object' &&
        cell !== null &&
        'value' in cell &&
        typeof (cell as { value: unknown }).value === 'object' &&
        (cell as { value: unknown }).value !== null &&
        'raw' in ((cell as { value: Record<string, unknown> }).value ?? {})
    ) {
        return (cell as { value: { raw: unknown } }).value.raw;
    }
    return cell;
};

/** Router exposing project explores and real metric query previews for Agent BI views. */
export const createCatalogExtRouter = (): Router => {
    const router = express.Router({ mergeParams: true });

    router.get(
        '/explores',
        allowApiKeyAuthentication,
        isAuthenticated,
        async (req, res, next) => {
            try {
                const { projectUuid } = req.params as { projectUuid: string };
                await requireFlagAndViewer(req, projectUuid);
                const projectService = req.services.getProjectService();
                const summaries = await projectService.getAllExploresSummary(
                    req.account!,
                    projectUuid,
                    false,
                );
                const validNames = summaries
                    .filter((item) => !isExploreError(item))
                    .map((item) => item.name)
                    .slice(0, 40);

                const resolved = await Promise.all(
                    validNames.map(
                        async (
                            exploreName,
                        ): Promise<AgentBiExploreSummary | null> => {
                            try {
                                const explore = await projectService.getExplore(
                                    req.account!,
                                    projectUuid,
                                    exploreName,
                                );
                                const dimensions: ExploreFieldSummary[] = [];
                                const metrics: ExploreFieldSummary[] = [];
                                for (const table of Object.values(
                                    explore.tables,
                                )) {
                                    for (const dim of Object.values(
                                        table.dimensions,
                                    )) {
                                        if (!dim.hidden) {
                                            dimensions.push({
                                                id: `${dim.table}_${dim.name}`,
                                                label: dim.label,
                                                table: table.name,
                                                type: dim.type,
                                            });
                                        }
                                    }
                                    for (const metric of Object.values(
                                        table.metrics,
                                    )) {
                                        if (!metric.hidden) {
                                            metrics.push({
                                                id: `${metric.table}_${metric.name}`,
                                                label: metric.label,
                                                table: table.name,
                                                type: metric.type,
                                            });
                                        }
                                    }
                                }
                                return {
                                    baseTable: explore.baseTable,
                                    dimensions,
                                    label: explore.label,
                                    metrics,
                                    name: explore.name,
                                };
                            } catch {
                                return null;
                            }
                        },
                    ),
                );
                const explores = resolved.filter(
                    (item): item is AgentBiExploreSummary => item !== null,
                );

                res.json({ status: 'ok', results: explores });
            } catch (error) {
                next(error);
            }
        },
    );

    router.post(
        '/metric-preview',
        allowApiKeyAuthentication,
        isAuthenticated,
        async (req, res, next) => {
            try {
                const { projectUuid } = req.params as { projectUuid: string };
                await requireFlagAndViewer(req, projectUuid);
                const parsed = metricPreviewSchema.safeParse(req.body);
                if (!parsed.success) {
                    throw new ParameterError('Invalid metric preview payload');
                }
                const { dimensions, exploreName, limit, metrics } = parsed.data;
                if (dimensions.length === 0 && metrics.length === 0) {
                    throw new ParameterError(
                        'At least one dimension or metric is required',
                    );
                }

                let sorts: Array<{ descending: boolean; fieldId: string }> = [];
                if (metrics[0]) {
                    sorts = [{ descending: true, fieldId: metrics[0] }];
                } else if (dimensions[0]) {
                    sorts = [{ descending: false, fieldId: dimensions[0] }];
                }

                const result = await req.services
                    .getProjectService()
                    .runMetricQuery({
                        account: req.account!,
                        csvLimit: null,
                        exploreName,
                        metricQuery: {
                            dimensions,
                            exploreName,
                            filters: {},
                            limit: limit ?? 50,
                            metrics,
                            sorts,
                            tableCalculations: [],
                        },
                        projectUuid,
                    });

                const columns: Record<
                    string,
                    {
                        format: string | null;
                        label: string | null;
                        type: string | null;
                    }
                > = {};
                for (const [fieldId, field] of Object.entries(result.fields)) {
                    columns[fieldId] = {
                        format:
                            'format' in field ? (field.format ?? null) : null,
                        label: 'label' in field ? field.label : fieldId,
                        type: 'type' in field ? String(field.type) : null,
                    };
                }

                const rows = result.rows
                    .slice(0, limit ?? 50)
                    .map((row) =>
                        Object.fromEntries(
                            Object.entries(row).map(([k, v]) => [
                                k,
                                unwrapCell(v),
                            ]),
                        ),
                    );

                res.json({
                    results: {
                        columns,
                        dimensions,
                        metrics,
                        rows,
                    },
                    status: 'ok',
                });
            } catch (error) {
                next(error);
            }
        },
    );

    return router;
};
