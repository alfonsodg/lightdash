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
    getAgentBiConfig,
    loadAgentBiConfig,
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
    ForbiddenError,
    NotFoundError,
    type Account,
    type SessionUser,
} from '@lightdash/common';
import type { Request } from 'express';
import type { AgentBiModel } from '../models/AgentBiModel';
import type { ProjectModel } from '../models/ProjectModel/ProjectModel';
import { syncAgentBiCatalogIndex } from './AgentBiCatalogIndex';
import {
    assertApprovedResumeContext,
    createContentValidators,
    createSpaceAccessVerifier,
    createSqlProvenanceResolvers,
    dryRunRenderer,
    toCatalogDocument,
    toOrchestratorSkills,
    toThreadHistory,
} from './AgentBiServiceHelpers';
import { BaseService } from './BaseService';

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
        this.validators = createContentValidators();
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
                const { catalogIndexLimit } = getAgentBiConfig();
                const { rows } = await this.agentBiModel.query(
                    'SELECT project_uuid, resource_type, resource_uuid, content, explore_name, table_name, field_name, field_kind FROM agent_ext.catalog_index WHERE project_uuid = $1 LIMIT $2',
                    [projectUuid, catalogIndexLimit],
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
        const { resolveChartSql, resolveDashboardSqlCharts } =
            createSqlProvenanceResolvers(this.agentBiModel);
        const verifySpaceAccess = createSpaceAccessVerifier(this.agentBiModel);
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
        limit = getAgentBiConfig().catalogSearchLimit,
        visibility: CatalogVisibility = { allowedExplores: new Set() },
    ): Promise<CatalogDocument[]> {
        const { catalogIndexLimit } = getAgentBiConfig();
        const { rows } = await this.agentBiModel.query(
            'SELECT project_uuid, resource_type, resource_uuid, content, explore_name, table_name, field_name, field_kind FROM agent_ext.catalog_index WHERE project_uuid = $1 LIMIT $2',
            [projectUuid, catalogIndexLimit],
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
        const config = loadAgentBiConfig(process.env);
        return createOpenAiChatClient({
            apiKey: config.llmApiKey ?? '',
            baseUrl: config.llmEndpoint ?? '',
            model: config.model,
            timeoutMs: config.llmTimeoutMs,
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
            await assertApprovedResumeContext(
                store,
                access,
                thread.threadUuid,
                input.resumeApproved,
                context,
            );
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
        const history = toThreadHistory(
            await store.listMessages(thread.threadUuid, access),
        );
        const skillStore = this.getSkillStore();
        const skills = toOrchestratorSkills(
            await skillStore.listSkills({ projectUuid: input.projectUuid }),
        );
        const catalogQuery =
            input.userText ??
            (input.resumeApproved === undefined
                ? ''
                : JSON.stringify(input.resumeApproved.input ?? null));
        const { getCatalogVisibility } = input;
        const { catalogSearchLimit, model: configuredModel } =
            getAgentBiConfig();
        const getCatalogContext = getCatalogVisibility
            ? async () => {
                  const visibility = await getCatalogVisibility();
                  return {
                      catalogMatches: await this.searchCatalogForProject(
                          input.projectUuid,
                          catalogQuery,
                          catalogSearchLimit,
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
                  catalogSearchLimit,
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
            model: input.model ?? configuredModel ?? '',
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
