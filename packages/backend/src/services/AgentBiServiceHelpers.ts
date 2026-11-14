import {
    hashContent,
    parseApprovalContent,
    type AgentPrincipal,
    type CatalogDocument,
    type ContentChartRenderer,
    type ContentSchemaValidator,
    type ContentValidators,
    type OrchestratorSkill,
    type ThreadStore,
} from '@lightdash/agent-bi';
import {
    ContentAsCodeType,
    dashboardAsCodeSchema,
    ForbiddenError,
    getChartAsCodeBranchSchema,
} from '@lightdash/common';
import { renderChart, type ChartView } from '@lightdash/visualization';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { isDeepStrictEqual } from 'node:util';
import type { AgentBiModel } from '../models/AgentBiModel';

type QueryRunner = Pick<AgentBiModel, 'query'>;

const toValidator = (validate: ValidateFunction): ContentSchemaValidator => ({
    validate: (content: unknown) => {
        if (validate(content) !== true) {
            return {
                errors: (validate.errors ?? []).map((error) =>
                    `${error.instancePath || '(root)'} ${error.message ?? 'invalid'}`.trim(),
                ),
                valid: false,
            };
        }
        return { errors: [], valid: true };
    },
});

export const createContentValidators = (): ContentValidators => {
    const ajv = new Ajv({ allErrors: true, discriminator: true });
    addFormats(ajv);
    return {
        chart: toValidator(
            ajv.compile(getChartAsCodeBranchSchema(ContentAsCodeType.CHART)),
        ),
        dashboard: toValidator(ajv.compile(dashboardAsCodeSchema)),
        sqlChart: toValidator(
            ajv.compile(
                getChartAsCodeBranchSchema(ContentAsCodeType.SQL_CHART),
            ),
        ),
    };
};

export const toCatalogDocument = (
    row: Record<string, unknown>,
): CatalogDocument => ({
    content: typeof row.content === 'string' ? row.content : '',
    contentHash: hashContent(
        typeof row.content === 'string' ? row.content : '',
    ),
    embedding: null,
    exploreName: typeof row.explore_name === 'string' ? row.explore_name : '',
    fieldKind:
        row.field_kind === 'dimension' || row.field_kind === 'metric'
            ? row.field_kind
            : null,
    fieldName: typeof row.field_name === 'string' ? row.field_name : null,
    projectUuid: typeof row.project_uuid === 'string' ? row.project_uuid : '',
    resourceType: row.resource_type as CatalogDocument['resourceType'],
    resourceUuid:
        typeof row.resource_uuid === 'string' ? row.resource_uuid : '',
    tableName: typeof row.table_name === 'string' ? row.table_name : null,
});

export const dryRunRenderer: ContentChartRenderer = {
    dryRun: (_kind, content) => {
        try {
            renderChart({ chartConfig: content } as ChartView, {
                fields: {},
                rows: [],
            });
            return { complete: true };
        } catch (error) {
            return {
                complete: false,
                reason:
                    error instanceof Error
                        ? error.message
                        : 'Unknown render error',
            };
        }
    },
};

export const createSqlProvenanceResolvers = (agentBiModel: QueryRunner) => {
    const resolveChartSql = async (projectUuid: string, chartUuid: string) => {
        const { rows } = await agentBiModel.query(
            `SELECT s.saved_sql_uuid, v.sql, v.limit
             FROM saved_sql s
             LEFT JOIN LATERAL (
                 SELECT sql, "limit"
                 FROM saved_sql_versions
                 WHERE saved_sql_uuid = s.saved_sql_uuid
                 ORDER BY created_at DESC, saved_sql_version_uuid DESC
                 LIMIT 1
             ) v ON true
             WHERE s.project_uuid = $1 AND s.saved_sql_uuid = $2`,
            [projectUuid, chartUuid],
        );
        if (rows.length > 0) {
            const row = rows[0] as Record<string, unknown>;
            return {
                isSqlChart: true,
                limit: typeof row.limit === 'number' ? row.limit : null,
                sql: typeof row.sql === 'string' ? row.sql : null,
            };
        }
        return { isSqlChart: false };
    };

    const resolveDashboardSqlCharts = async (
        projectUuid: string,
        dashboardUuidOrSlug: string,
    ) => {
        const { rows } = await agentBiModel.query(
            `SELECT s.saved_sql_uuid, v.sql, v.limit
             FROM dashboards d
             JOIN dashboard_versions dv ON dv.dashboard_id = d.dashboard_id
             JOIN dashboard_views dvs ON dvs.dashboard_version_id = dv.dashboard_version_id
             JOIN dashboard_tiles dt ON dt.dashboard_version_id = dv.dashboard_version_id
             JOIN dashboard_tile_sql_charts dtsc ON dtsc.dashboard_tile_uuid = dt.dashboard_tile_uuid
             JOIN saved_sql s ON s.saved_sql_uuid = dtsc.saved_sql_uuid
             LEFT JOIN LATERAL (
                 SELECT sql, "limit"
                 FROM saved_sql_versions
                 WHERE saved_sql_uuid = s.saved_sql_uuid
                 ORDER BY created_at DESC, saved_sql_version_uuid DESC
                 LIMIT 1
             ) v ON true
             WHERE d.project_uuid = $1 AND (d.dashboard_uuid::text = $2 OR d.slug = $2)`,
            [projectUuid, dashboardUuidOrSlug],
        );
        return rows.map((row) => {
            const record = row as Record<string, unknown>;
            return {
                isSqlChart: true,
                limit: typeof record.limit === 'number' ? record.limit : null,
                sql: typeof record.sql === 'string' ? record.sql : null,
            };
        });
    };

    return { resolveChartSql, resolveDashboardSqlCharts };
};

export const createSpaceAccessVerifier =
    (agentBiModel: QueryRunner) =>
    async (
        projectUuid: string,
        spaceSlug: string,
        principal?: AgentPrincipal,
    ) => {
        const { rows } = await agentBiModel.query(
            `SELECT s.space_uuid, s.project_member_access_role
             FROM spaces s
             JOIN projects p ON p.project_id = s.project_id
             WHERE p.project_uuid = $1 AND s.slug = $2 AND s.deleted_at IS NULL
             LIMIT 1`,
            [projectUuid, spaceSlug],
        );
        if (rows.length === 0) {
            return { exists: false, isPublic: false, writable: false };
        }
        const row = rows[0] as Record<string, unknown>;
        const spaceUuid =
            typeof row.space_uuid === 'string' ? row.space_uuid : null;
        const projectRole =
            typeof row.project_member_access_role === 'string'
                ? row.project_member_access_role
                : null;
        const isPublic = projectRole !== null;

        if (!principal?.userUuid || spaceUuid === null) {
            return { exists: isPublic, isPublic, writable: false };
        }

        const [adminAccess, userAccess, groupAccess] = await Promise.all([
            agentBiModel.query(
                `SELECT 1
                 FROM projects p
                 JOIN users u ON u.user_uuid = $2
                 LEFT JOIN organization_memberships om
                     ON om.organization_id = p.organization_id AND om.user_id = u.user_id
                 LEFT JOIN project_memberships pm
                     ON pm.project_id = p.project_id AND pm.user_id = u.user_id
                 WHERE p.project_uuid = $1
                   AND (om.role = 'admin' OR pm.role = 'admin')
                 LIMIT 1`,
                [projectUuid, principal.userUuid],
            ),
            agentBiModel.query(
                `SELECT space_role FROM space_user_access
                 WHERE space_uuid = $1 AND user_uuid = $2`,
                [spaceUuid, principal.userUuid],
            ),
            agentBiModel.query(
                `SELECT sga.space_role
                 FROM space_group_access sga
                 JOIN group_memberships gm ON gm.group_uuid = sga.group_uuid
                 WHERE sga.space_uuid = $1 AND gm.user_uuid = $2`,
                [spaceUuid, principal.userUuid],
            ),
        ]);

        if (adminAccess.rows.length > 0) {
            return { exists: true, isPublic, writable: true };
        }

        const directRoles = [...userAccess.rows, ...groupAccess.rows]
            .map((r) => (r as Record<string, unknown>).space_role)
            .filter((role): role is string => typeof role === 'string');

        if (!isPublic && directRoles.length === 0) {
            return { exists: false, isPublic: false, writable: false };
        }

        const writeRoles = new Set(['editor', 'admin']);
        const writable =
            (projectRole !== null && writeRoles.has(projectRole)) ||
            directRoles.some((role) => writeRoles.has(role));

        return {
            exists: true,
            isPublic,
            writable,
        };
    };

export const toThreadHistory = (
    messages: ReadonlyArray<{ content: unknown; role: unknown }>,
): Array<{ content: string; role: 'assistant' | 'user' }> =>
    messages
        .filter((message) => {
            if (message.role !== 'user' && message.role !== 'assistant') {
                return false;
            }
            if (typeof message.content !== 'string') {
                return false;
            }
            try {
                const parsed = JSON.parse(message.content) as unknown;
                if (
                    parsed !== null &&
                    typeof parsed === 'object' &&
                    'kind' in parsed &&
                    (parsed as { kind?: unknown }).kind === 'approval_request'
                ) {
                    return false;
                }
            } catch {
                // Plain text history is kept as is.
            }
            return true;
        })
        .map((message) => ({
            content: message.content as string,
            role: message.role as 'assistant' | 'user',
        }));

export const toOrchestratorSkills = (
    skills: ReadonlyArray<{ manifest: unknown; slug: string }>,
): OrchestratorSkill[] =>
    skills.map((skill) => ({
        content:
            typeof skill.manifest === 'string'
                ? skill.manifest
                : JSON.stringify(skill.manifest ?? {}),
        slug: skill.slug,
    }));

export const assertApprovedResumeContext = async (
    store: ThreadStore,
    access: {
        isOrgAdmin: boolean;
        organizationUuid: string;
        requesterUuid: string;
    },
    threadUuid: string,
    resumeApproved: { approvalUuid: string; input: unknown; tool: string },
    context: {
        pinnedContext: unknown;
        runtimeOverrides: unknown;
    } | null,
): Promise<void> => {
    const recorded = await store.getMessage(
        resumeApproved.approvalUuid,
        access,
    );
    const recordedRequest =
        recorded === null || recorded.role !== 'system'
            ? null
            : parseApprovalContent(
                  recorded.messageUuid,
                  recorded.threadUuid,
                  recorded.content,
              );
    if (
        recordedRequest === null ||
        recordedRequest.threadUuid !== threadUuid ||
        recordedRequest.status !== 'approved' ||
        !isDeepStrictEqual(recordedRequest.context, context) ||
        recordedRequest.tool !== resumeApproved.tool ||
        !isDeepStrictEqual(
            recordedRequest.input ?? null,
            resumeApproved.input ?? null,
        )
    ) {
        throw new ForbiddenError();
    }
};
