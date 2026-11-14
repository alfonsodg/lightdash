import { z } from 'zod';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { evaluateSqlGuard } from '../guardrails/sqlAstGuard';
import {
    AgentToolError,
    formatValidationError,
    type AgentToolRuntimeOptions,
} from '../tools/agentToolTypes';
import {
    buildCodeChartItemPath,
    buildCodeDashboardItemPath,
    buildCodeSqlChartItemPath,
} from './contentFetch';
import {
    asArray,
    asRecord,
    assertSafeSpaceTarget,
    assertSchemaValid,
    KIND_LIST_KEYS,
    KIND_LIST_PATHS,
    requireContentDeps,
    runGuardedContent,
    stripNullDashboardSlug,
    unwrapResults,
    withForce,
    type GuardAuditDetail,
    type InvokeFn,
} from './contentHelpers';
import {
    CONTENT_TOOL_NAMES,
    getChartOrDashboardInputSchema,
    getChartOrDashboardOutputSchema,
    upsertChartAsCodeInputSchema,
    upsertContentOutputSchema,
    upsertDashboardAsCodeInputSchema,
    upsertSqlChartAsCodeInputSchema,
    validateChartConfigInputSchema,
    validateChartConfigOutputSchema,
    type ContentToolDeps,
    type ContentToolName,
    type GetChartOrDashboardInput,
    type GetChartOrDashboardOutput,
    type UpsertChartAsCodeInput,
    type UpsertContentOutput,
    type UpsertDashboardAsCodeInput,
    type UpsertSqlChartAsCodeInput,
    type ValidateChartConfigInput,
    type ValidateChartConfigOutput,
} from './contentSchemas';

export { AgentToolError } from '../tools/agentToolTypes';
export {
    CONTENT_CAPABILITY,
    CONTENT_TOOL_NAMES,
    contentKindSchema,
    getChartOrDashboardInputSchema,
    getChartOrDashboardOutputSchema,
    upsertChartAsCodeInputSchema,
    upsertContentOutputSchema,
    upsertDashboardAsCodeInputSchema,
    upsertSqlChartAsCodeInputSchema,
    validateChartConfigInputSchema,
    validateChartConfigOutputSchema,
    type ChartDryRunResult,
    type ContentChartRenderer,
    type ContentSchemaValidator,
    type ContentSqlApproval,
    type ContentToolDeps,
    type ContentToolName,
    type ContentValidators,
    type GetChartOrDashboardInput,
    type GetChartOrDashboardOutput,
    type SpaceAccessVerdict,
    type UpsertChartAsCodeInput,
    type UpsertContentOutput,
    type UpsertDashboardAsCodeInput,
    type UpsertSqlChartAsCodeInput,
    type ValidateChartConfigInput,
    type ValidateChartConfigOutput,
} from './contentSchemas';

export const createContentTools = (deps: ContentToolDeps) => {
    requireContentDeps(deps);

    const guard = (
        tool: ContentToolName,
        input: { projectUuid: string },
        principal: AgentPrincipal,
        options: AgentToolRuntimeOptions,
        outputSchema: z.ZodType<unknown>,
        invoke: InvokeFn,
        detail: GuardAuditDetail = {},
    ): Promise<unknown> =>
        runGuardedContent(
            deps,
            tool,
            input,
            principal,
            options,
            outputSchema,
            invoke,
            detail,
        );

    const handlers = {
        upsert_chart_as_code: (
            input: UpsertChartAsCodeInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'upsert_chart_as_code',
                input,
                principal,
                options,
                upsertContentOutputSchema,
                async () => {
                    await assertSafeSpaceTarget(
                        deps,
                        input.projectUuid,
                        input.chart,
                        principal,
                    );
                    const normalizedChart = stripNullDashboardSlug({
                        ...input.chart,
                        slug: input.slug,
                    });
                    await assertSchemaValid(
                        deps.validators,
                        'chart',
                        normalizedChart,
                    );
                    const results = unwrapResults(
                        await deps.contentFetch(
                            {
                                body: withForce(normalizedChart, input.force),
                                method: 'POST',
                                path: buildCodeChartItemPath(
                                    input.projectUuid,
                                    input.slug,
                                ),
                            },
                            options,
                        ),
                    );
                    return { changes: asRecord(results), slug: input.slug };
                },
            ) as Promise<UpsertContentOutput>,

        upsert_sql_chart_as_code: (
            input: UpsertSqlChartAsCodeInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'upsert_sql_chart_as_code',
                input,
                principal,
                options,
                upsertContentOutputSchema,
                async () => {
                    await assertSafeSpaceTarget(
                        deps,
                        input.projectUuid,
                        input.sqlChart,
                        principal,
                    );
                    await assertSchemaValid(deps.validators, 'sql_chart', {
                        ...input.sqlChart,
                        slug: input.slug,
                    });
                    const { limit, sql } = input.sqlChart;
                    if (typeof sql !== 'string' || sql.trim().length === 0) {
                        throw new AgentToolError(
                            'INVALID_INPUT',
                            'A SQL chart needs a sql string.',
                        );
                    }
                    const guardVerdict = evaluateSqlGuard(sql, {
                        approvalToken: input.approvalToken ?? null,
                        dialect: deps.sqlApproval.dialect ?? null,
                        expectedApprovalToken:
                            deps.sqlApproval.expectedApprovalToken ?? null,
                        maxRows:
                            typeof limit === 'number'
                                ? limit
                                : (deps.sqlApproval.maxRows ?? undefined),
                        principal: {
                            organizationUuid: principal.organizationUuid,
                            userUuid: principal.userUuid,
                        },
                        readOnly: {
                            enforced: deps.sqlApproval.readOnlyEnforced,
                        },
                    });
                    if (!guardVerdict.allowed) {
                        throw new AgentToolError(
                            'GUARD_DENIED',
                            guardVerdict.message,
                            guardVerdict.reason,
                        );
                    }
                    const results = unwrapResults(
                        await deps.contentFetch(
                            {
                                body: withForce(
                                    { ...input.sqlChart, slug: input.slug },
                                    input.force,
                                ),
                                method: 'POST',
                                path: buildCodeSqlChartItemPath(
                                    input.projectUuid,
                                    input.slug,
                                ),
                            },
                            options,
                        ),
                    );
                    return { changes: asRecord(results), slug: input.slug };
                },
                { approvalPresented: input.approvalToken !== undefined },
            ) as Promise<UpsertContentOutput>,

        upsert_dashboard_as_code: (
            input: UpsertDashboardAsCodeInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'upsert_dashboard_as_code',
                input,
                principal,
                options,
                upsertContentOutputSchema,
                async () => {
                    await assertSafeSpaceTarget(
                        deps,
                        input.projectUuid,
                        input.dashboard,
                        principal,
                    );
                    await assertSchemaValid(deps.validators, 'dashboard', {
                        ...input.dashboard,
                        slug: input.slug,
                    });
                    const results = unwrapResults(
                        await deps.contentFetch(
                            {
                                body: withForce(
                                    { ...input.dashboard, slug: input.slug },
                                    input.force,
                                ),
                                method: 'POST',
                                path: buildCodeDashboardItemPath(
                                    input.projectUuid,
                                    input.slug,
                                ),
                            },
                            options,
                        ),
                    );
                    return { changes: asRecord(results), slug: input.slug };
                },
            ) as Promise<UpsertContentOutput>,

        get_chart_or_dashboard: (
            input: GetChartOrDashboardInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) => {
            const listKey =
                KIND_LIST_KEYS[input.kind] ?? KIND_LIST_KEYS['dashboard'];
            const listPathBuilder =
                KIND_LIST_PATHS[input.kind] ?? KIND_LIST_PATHS['dashboard'];
            const path = listPathBuilder(input.projectUuid);
            let found: Record<string, unknown> | null = null;
            return guard(
                'get_chart_or_dashboard',
                input,
                principal,
                options,
                getChartOrDashboardOutputSchema,
                async () => {
                    const results = unwrapResults(
                        await deps.contentFetch(
                            {
                                method: 'GET',
                                path,
                                query: { ids: input.slug },
                            },
                            options,
                        ),
                    );
                    const items = asArray(asRecord(results)[listKey])
                        .map((entry) => asRecord(entry))
                        .filter((entry) => typeof entry['slug'] === 'string');
                    const match =
                        items.find((entry) => entry['slug'] === input.slug) ??
                        null;
                    found = match;
                    if (match === null) {
                        throw new AgentToolError(
                            'UPSTREAM_ERROR',
                            `No ${input.kind} found for slug "${input.slug}".`,
                        );
                    }
                    return { item: match, kind: input.kind, slug: input.slug };
                },
                {
                    get rowCount() {
                        return found !== null ? 1 : 0;
                    },
                },
            ) as Promise<GetChartOrDashboardOutput>;
        },

        validate_chart_config: (
            input: ValidateChartConfigInput,
            principal: AgentPrincipal,
            options: AgentToolRuntimeOptions = {},
        ) =>
            guard(
                'validate_chart_config',
                input,
                principal,
                options,
                validateChartConfigOutputSchema,
                async () => {
                    await assertSchemaValid(
                        deps.validators,
                        input.kind,
                        input.config,
                    );
                    if (input.kind === 'chart' || input.kind === 'sql_chart') {
                        const dryRun = await deps.renderer.dryRun(
                            input.kind,
                            input.config,
                        );
                        if (!dryRun.complete) {
                            throw new AgentToolError(
                                'INVALID_INPUT',
                                `The chart config cannot draw (${dryRun.reason ?? 'unknown reason'}).`,
                            );
                        }
                    }
                    return { kind: input.kind, valid: true as const };
                },
            ) as Promise<ValidateChartConfigOutput>,
    };

    const inputSchemas: Record<ContentToolName, z.ZodType<unknown>> = {
        get_chart_or_dashboard: getChartOrDashboardInputSchema,
        upsert_chart_as_code: upsertChartAsCodeInputSchema,
        upsert_dashboard_as_code: upsertDashboardAsCodeInputSchema,
        upsert_sql_chart_as_code: upsertSqlChartAsCodeInputSchema,
        validate_chart_config: validateChartConfigInputSchema,
    };

    const executeTool = async (
        toolName: string,
        rawInput: unknown,
        principal: AgentPrincipal,
        options: AgentToolRuntimeOptions = {},
    ): Promise<unknown> => {
        if (
            !CONTENT_TOOL_NAMES.includes(toolName as ContentToolName) ||
            !(toolName in handlers)
        ) {
            throw new AgentToolError(
                'UNKNOWN_TOOL',
                `Tool "${toolName}" is not recognized.`,
            );
        }
        const name = toolName as ContentToolName;
        const parsed = inputSchemas[name].safeParse(rawInput);
        if (!parsed.success) {
            throw new AgentToolError(
                'INVALID_INPUT',
                formatValidationError(parsed.error),
            );
        }
        return handlers[name](parsed.data as never, principal, options);
    };

    return {
        executeTool,
        handlers,
        inputSchemas,
        toolNames: CONTENT_TOOL_NAMES,
    };
};
