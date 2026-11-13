import { subject } from '@casl/ability';
import {
    createContentFetchClient,
    createDiscoveryFetchClient,
    createExportFetchClient,
    createLightdashV2Client,
    createOpenAiChatClient,
    createSkillStore,
    createThreadStore,
    createToolCatalog,
    defaultCapabilityToggles,
    defaultExportPollConfig,
    hashContent,
    parseApprovalContent,
    requestApproval,
    resolveApproval,
    runAgentTurn,
    searchCatalogDocuments,
    type AgentPrincipal,
    type ApprovalRequest,
    type AuditQueryClient,
    type CatalogDocument,
    type CatalogFieldSearcher,
    type CatalogVisibility,
    type ContentChartRenderer,
    type ContentSchemaValidator,
    type ContentSqlApproval,
    type ContentValidators,
    type LlmChatClient,
    type McpServerDeps,
    type OrchestratorEvent,
    type OrchestratorOutcome,
    type RawSqlGuardrails,
    type RuntimeOverrides,
    type RuntimePinnedContext,
    type SkillStore,
    type ThreadStore,
} from '@lightdash/agent-bi';
import {
    chartAsCodeSchema,
    ContentAsCodeType,
    dashboardAsCodeSchema,
    ForbiddenError,
    getChartAsCodeBranchSchema,
    NotFoundError,
    type Account,
    type SessionUser,
} from '@lightdash/common';
import { renderChart, type ChartView } from '@lightdash/visualization';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { Request } from 'express';
import { isDeepStrictEqual } from 'node:util';
import type { AgentBiModel } from '../models/AgentBiModel';
import type { ProjectModel } from '../models/ProjectModel/ProjectModel';
import { syncAgentBiCatalogIndex } from './AgentBiCatalogIndex';
import { BaseService } from './BaseService';

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

const toCatalogDocument = (row: Record<string, unknown>): CatalogDocument => ({
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

const dryRunRenderer: ContentChartRenderer = {
    dryRun: (kind, content) => {
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

export class AgentBiService extends BaseService {
    private readonly agentBiModel: AgentBiModel;

    private readonly projectModel: Pick<
        ProjectModel,
        'get' | 'findExploresFromCache'
    >;

    private readonly siteUrl: string;

    private readonly validators: ContentValidators;

    constructor({
        agentBiModel,
        projectModel,
        siteUrl,
    }: {
        agentBiModel: AgentBiModel;
        projectModel: Pick<ProjectModel, 'get' | 'findExploresFromCache'>;
        siteUrl: string;
    }) {
        super();
        this.agentBiModel = agentBiModel;
        this.projectModel = projectModel;
        this.siteUrl = siteUrl.replace(/\/+$/, '');
        const ajv = new Ajv({ allErrors: true, discriminator: true });
        addFormats(ajv);
        this.validators = {
            chart: toValidator(
                ajv.compile(
                    getChartAsCodeBranchSchema(ContentAsCodeType.CHART),
                ),
            ),
            dashboard: toValidator(ajv.compile(dashboardAsCodeSchema)),
            sqlChart: toValidator(
                ajv.compile(
                    getChartAsCodeBranchSchema(ContentAsCodeType.SQL_CHART),
                ),
            ),
        };
    }

    buildMcpServerDeps(req: Request): McpServerDeps {
        const headers: Record<string, string> = {};
        const { authorization } = req.headers;
        if (typeof authorization === 'string' && authorization.length > 0) {
            headers.Authorization = authorization;
        }
        return this.buildToolDeps(headers);
    }

    buildToolDeps(headers: Record<string, string>): McpServerDeps {
        const auditClient: AuditQueryClient = {
            query: async (text, params) =>
                this.agentBiModel.query(text, params),
        };
        const catalogSearch: CatalogFieldSearcher = {
            search: async (query, visibility, limit, projectUuid) => {
                const { rows } = await this.agentBiModel.query(
                    'SELECT project_uuid, resource_type, resource_uuid, content, explore_name, table_name, field_name, field_kind FROM agent_ext.catalog_index WHERE project_uuid = $1 LIMIT 2000',
                    [projectUuid],
                );
                const hits = searchCatalogDocuments(
                    rows.map(toCatalogDocument),
                    query,
                    visibility,
                );
                return typeof limit === 'number'
                    ? hits.slice(0, Math.max(0, limit))
                    : hits;
            },
        };
        const queryClient = createLightdashV2Client({
            baseUrl: this.siteUrl,
            headers,
        });
        const rawSql: RawSqlGuardrails = { readOnlyEnforced: false };
        const sqlApproval: ContentSqlApproval = { readOnlyEnforced: false };
        const resolveChartSql = async (
            projectUuid: string,
            chartUuid: string,
        ) => {
            const { rows } = await this.agentBiModel.query(
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
            const { rows } = await this.agentBiModel.query(
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
                    limit:
                        typeof record.limit === 'number' ? record.limit : null,
                    sql: typeof record.sql === 'string' ? record.sql : null,
                };
            });
        };
        const verifySpaceAccess = async (
            projectUuid: string,
            spaceSlug: string,
        ) => {
            const { rows } = await this.agentBiModel.query(
                `SELECT s.project_member_access_role
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
            return {
                exists: true,
                isPublic: row.project_member_access_role !== null,
                writable: true,
            };
        };
        return {
            auditClient,
            catalogSearch,
            contentFetch: createContentFetchClient({
                baseUrl: this.siteUrl,
                headers,
            }),
            discoveryFetch: createDiscoveryFetchClient({
                baseUrl: this.siteUrl,
                headers,
            }),
            exportFetch: createExportFetchClient({
                baseUrl: this.siteUrl,
                headers,
            }),
            fieldValuesClient: {
                executeFieldValueSearch: queryClient.executeFieldValueSearch,
                pollQueryToReady: queryClient.pollQueryToReady,
            },
            policyContext: { toggles: defaultCapabilityToggles() },
            poll: defaultExportPollConfig(),
            queryClient,
            rawSql,
            renderer: dryRunRenderer,
            resolveChartSql,
            resolveDashboardSqlCharts,
            sqlApproval,
            validators: this.validators,
            verifySpaceAccess,
        };
    }

    getThreadStore(): ThreadStore {
        return createThreadStore({
            query: (text, params) => this.agentBiModel.query(text, params),
        });
    }

    getSkillStore(): SkillStore {
        return createSkillStore({
            query: (text, params) => this.agentBiModel.query(text, params),
        });
    }

    private async getProjectOrThrow(projectUuid: string) {
        return this.projectModel.get(projectUuid);
    }

    async requireProjectViewer(
        account: Account | SessionUser,
        projectUuid: string,
    ): Promise<{ organizationUuid: string }> {
        const project = await this.getProjectOrThrow(projectUuid);
        const ability = this.createAuditedAbility(account);
        if (
            ability.cannot(
                'view',
                subject('Project', {
                    organizationUuid: project.organizationUuid,
                    projectUuid,
                }),
            )
        ) {
            throw new ForbiddenError();
        }
        return { organizationUuid: project.organizationUuid };
    }

    async requireSkillsEditor(
        account: Account | SessionUser,
        projectUuid: string,
    ): Promise<{ organizationUuid: string }> {
        const project = await this.getProjectOrThrow(projectUuid);
        const ability = this.createAuditedAbility(account);
        if (
            ability.cannot(
                'manage',
                subject('AiAgentSkill', {
                    organizationUuid: project.organizationUuid,
                    projectUuid,
                }),
            )
        ) {
            throw new ForbiddenError();
        }
        return { organizationUuid: project.organizationUuid };
    }

    async requireSkillsViewer(
        account: Account | SessionUser,
        projectUuid: string,
    ): Promise<{ organizationUuid: string }> {
        const project = await this.getProjectOrThrow(projectUuid);
        const ability = this.createAuditedAbility(account);
        if (
            ability.cannot(
                'view',
                subject('AiAgentSkill', {
                    organizationUuid: project.organizationUuid,
                    projectUuid,
                }),
            )
        ) {
            throw new ForbiddenError();
        }
        return { organizationUuid: project.organizationUuid };
    }

    async requireThreadCreator(
        account: Account | SessionUser,
        projectUuid: string,
    ): Promise<{ organizationUuid: string }> {
        const project = await this.getProjectOrThrow(projectUuid);
        const ability = this.createAuditedAbility(account);
        const canCreate = ability.can(
            'create',
            subject('AiAgentThread', {
                organizationUuid: project.organizationUuid,
                projectUuid,
            }),
        );
        if (!canCreate) {
            throw new ForbiddenError();
        }
        return { organizationUuid: project.organizationUuid };
    }

    isProjectAuditor(
        account: Account | SessionUser,
        organizationUuid: string,
        projectUuid: string,
    ): boolean {
        const ability = this.createAuditedAbility(account);
        return ability.can(
            'manage',
            subject('AiAgentThread', { organizationUuid, projectUuid }),
        );
    }

    async searchCatalogForProject(
        projectUuid: string,
        query: string,
        limit = 8,
        visibility: CatalogVisibility = { allowedExplores: new Set() },
    ): Promise<CatalogDocument[]> {
        const { rows } = await this.agentBiModel.query(
            'SELECT project_uuid, resource_type, resource_uuid, content, explore_name, table_name, field_name, field_kind FROM agent_ext.catalog_index WHERE project_uuid = $1 LIMIT 2000',
            [projectUuid],
        );
        const documents = rows.map(toCatalogDocument);
        return searchCatalogDocuments(
            documents.filter((document) => document.fieldKind !== null),
            query,
            visibility,
            { limit },
        ).map((hit) => hit.document);
    }

    async getCatalogExploreNames(projectUuid: string): Promise<string[]> {
        await syncAgentBiCatalogIndex({
            agentBiModel: this.agentBiModel,
            projectModel: this.projectModel,
            projectUuid,
        });
        const { rows } = await this.agentBiModel.query(
            'SELECT DISTINCT explore_name FROM agent_ext.catalog_index WHERE project_uuid = $1 AND explore_name <> $2 ORDER BY explore_name',
            [projectUuid, ''],
        );
        return rows
            .map((row) => row.explore_name)
            .filter((name): name is string => typeof name === 'string');
    }

    buildLlmClient(): LlmChatClient {
        const timeoutMs = Number(process.env.AGENT_LLM_TIMEOUT_MS ?? '');
        return createOpenAiChatClient({
            apiKey: process.env.AGENT_LLM_API_KEY ?? '',
            baseUrl: process.env.AGENT_LLM_BASE_URL ?? '',
            model: process.env.AGENT_LLM_MODEL || undefined,
            timeoutMs:
                Number.isInteger(timeoutMs) && timeoutMs > 0
                    ? timeoutMs
                    : 60_000,
        });
    }

    async runThreadTurn(input: {
        access: {
            organizationUuid: string;
            requesterUuid: string;
            isOrgAdmin?: boolean;
        };
        authorizeContext?: () => Promise<void>;
        headers?: Record<string, string>;
        getCatalogVisibility?: () => Promise<CatalogVisibility>;
        llm?: LlmChatClient;
        maxTurns?: number;
        model?: string;
        onEvent: (event: OrchestratorEvent) => void;
        pinnedContext?: RuntimePinnedContext | null;
        principal: AgentPrincipal;
        projectUuid: string;
        resumeApproved?: { approvalUuid: string; input: unknown; tool: string };
        runtimeOverrides?: RuntimeOverrides | null;
        threadUuid: string;
        userText?: string;
    }): Promise<OrchestratorOutcome & { threadUuid: string }> {
        const access = {
            isOrgAdmin: input.access.isOrgAdmin ?? false,
            organizationUuid: input.access.organizationUuid,
            requesterUuid: input.access.requesterUuid,
        };
        await input.authorizeContext?.();
        const store = this.getThreadStore();
        const thread = await store.getThread(input.threadUuid, access);
        if (thread === null || thread.projectUuid !== input.projectUuid) {
            throw new ForbiddenError();
        }
        const context =
            input.pinnedContext == null && input.runtimeOverrides == null
                ? null
                : {
                      pinnedContext: input.pinnedContext ?? null,
                      runtimeOverrides: input.runtimeOverrides ?? null,
                  };
        if (input.resumeApproved !== undefined) {
            const recorded = await store.getMessage(
                input.resumeApproved.approvalUuid,
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
                recordedRequest.threadUuid !== thread.threadUuid ||
                recordedRequest.status !== 'approved' ||
                !isDeepStrictEqual(recordedRequest.context, context) ||
                recordedRequest.tool !== input.resumeApproved.tool ||
                !isDeepStrictEqual(
                    recordedRequest.input ?? null,
                    input.resumeApproved.input ?? null,
                )
            ) {
                throw new ForbiddenError();
            }
        }
        if (input.userText !== undefined && input.userText !== '') {
            await store.createMessage(
                {
                    content: input.userText,
                    role: 'user',
                    threadUuid: thread.threadUuid,
                },
                access,
            );
        }
        const history = (await store.listMessages(thread.threadUuid, access))
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
                        (parsed as { kind?: unknown }).kind ===
                            'approval_request'
                    ) {
                        return false;
                    }
                } catch {
                    // Plain text history is kept as is.
                }
                return true;
            })
            .map((message) => ({
                content: message.content,
                role: message.role as 'assistant' | 'user',
            }));
        const skillStore = this.getSkillStore();
        const skills = (
            await skillStore.listSkills({ projectUuid: input.projectUuid })
        ).map((skill) => ({
            content:
                typeof skill.manifest === 'string'
                    ? skill.manifest
                    : JSON.stringify(skill.manifest ?? {}),
            slug: skill.slug,
        }));
        const catalogQuery =
            input.userText ??
            (input.resumeApproved === undefined
                ? ''
                : JSON.stringify(input.resumeApproved.input ?? null));
        const { getCatalogVisibility } = input;
        const getCatalogContext = getCatalogVisibility
            ? async () => {
                  const visibility = await getCatalogVisibility();
                  return {
                      catalogMatches: await this.searchCatalogForProject(
                          input.projectUuid,
                          catalogQuery,
                          8,
                          visibility,
                      ),
                      visibility,
                  };
              }
            : undefined;
        const catalogMatches = getCatalogContext
            ? []
            : await this.searchCatalogForProject(
                  input.projectUuid,
                  catalogQuery,
                  8,
                  { allowedExplores: new Set() },
              );
        const catalog = createToolCatalog(
            this.buildToolDeps(input.headers ?? {}),
        );
        const outcome = await runAgentTurn({
            approvals: {
                requestApproval: (tool, toolInput) =>
                    requestApproval(store, {
                        access,
                        context,
                        input: toolInput,
                        threadUuid: thread.threadUuid,
                        tool,
                    }).then((approval) => ({
                        approvalUuid: approval.approvalUuid,
                    })),
            },
            authorizeContext: input.authorizeContext,
            catalogMatches,
            history,
            llm: input.llm ?? this.buildLlmClient(),
            maxTurns: input.maxTurns,
            model: input.model ?? process.env.AGENT_LLM_MODEL ?? 'default',
            pinnedContext: input.pinnedContext ?? null,
            policyToggles: defaultCapabilityToggles(),
            principal: input.principal,
            projectUuid: input.projectUuid,
            resumeApproved: input.resumeApproved ?? null,
            runtimeOverrides: input.runtimeOverrides ?? null,
            skills,
            tools: {
                execute: (tool, toolInput, principal, options) =>
                    catalog.execute(tool, toolInput, principal, options),
            },
            getCatalogContext,
            userText: input.userText ?? '',
            onEvent: input.onEvent,
        });
        if (outcome.status === 'completed' && outcome.text !== null) {
            await store.createMessage(
                {
                    content: outcome.text,
                    role: 'assistant',
                    threadUuid: thread.threadUuid,
                },
                access,
            );
        }
        return { ...outcome, threadUuid: thread.threadUuid };
    }

    async resolveThreadApproval(
        account: Account | SessionUser,
        principal: AgentPrincipal,
        projectUuid: string,
        threadUuid: string,
        approvalUuid: string,
        decision: 'approved' | 'rejected',
    ): Promise<ApprovalRequest> {
        const { organizationUuid } = await this.requireProjectViewer(
            account,
            projectUuid,
        );
        const access = {
            isOrgAdmin: this.isProjectAuditor(
                account,
                organizationUuid,
                projectUuid,
            ),
            organizationUuid,
            requesterUuid: principal.userUuid,
        };
        const store = this.getThreadStore();
        const thread = await store.getThread(threadUuid, access);
        if (thread === null || thread.projectUuid !== projectUuid) {
            throw new NotFoundError('Thread was not found.');
        }
        return resolveApproval(store, {
            access,
            approvalUuid,
            decision,
        });
    }
}
