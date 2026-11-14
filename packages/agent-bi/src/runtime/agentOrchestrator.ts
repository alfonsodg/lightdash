// Streaming tool-calling loop over the agent tool catalogue. The loop is
// transport-agnostic: it emits events and the host renders them (SSE,
// stdio, tests). Policy stays with the tools; approvals suspend the run.
import { z } from 'zod';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import type {
    CatalogDocument,
    CatalogVisibility,
} from '../catalog/catalogIndexer';
import { evaluateCapability } from '../policy/capabilityPolicy';
import type { AgentCapabilityToggles } from '../policy/capabilityPolicy';
import { TOOL_CATALOG, type ToolCatalogAllDeps } from '../tools/toolCatalog';
import {
    buildSystemPrompt,
    escapeUntrusted,
    type OrchestratorSkill,
    type RuntimeOverrides,
    type RuntimePinnedContext,
} from './agentPrompt';
import type { LlmChatClient, LlmChatMessage, LlmChatResult } from './llmClient';

export {
    buildSystemPrompt,
    escapeUntrusted,
    type OrchestratorSkill,
    type RuntimeOverrides,
    type RuntimePinnedContext,
} from './agentPrompt';
export type LlmScript = LlmChatResult[];

export interface ApprovalRequester {
    requestApproval(
        tool: string,
        input: unknown,
    ): Promise<{ approvalUuid: string }>;
}

type QueryArtifactPreview = {
    columns: Record<
        string,
        { format: string | null; label: string | null; type: string | null }
    >;
    dimensions: string[];
    metrics: string[];
    rows: Array<Record<string, unknown>>;
};

export type OrchestratorEvent =
    | { message: string; type: 'status' }
    | { id: string; input: unknown; tool: string; type: 'tool_call' }
    | { id: string; ok: boolean; tool: string; type: 'tool_result' }
    | {
          kind: string;
          preview?: QueryArtifactPreview;
          slug?: string;
          tool: string;
          type: 'chart_artifact';
          uuid?: string;
      }
    | {
          approvalUuid: string;
          input: unknown;
          tool: string;
          type: 'approval_required';
      }
    | { text: string; type: 'text_delta' }
    | {
          status: 'completed' | 'max_turns';
          text: string | null;
          type: 'done';
          usage: { completionTokens: number; promptTokens: number };
      }
    | { message: string; type: 'error' };

export interface OrchestratorOutcome {
    approvalUuid?: string;
    status: 'approval_required' | 'completed' | 'error' | 'max_turns';
    text: string | null;
    usage: { completionTokens: number; promptTokens: number };
}

export interface OrchestratorToolExecutor {
    execute(
        toolName: string,
        input: unknown,
        principal: AgentPrincipal,
        options?: { visibility: CatalogVisibility },
    ): Promise<unknown>;
}

export interface OrchestratorDeps {
    approvals: ApprovalRequester | null;
    authorizeContext?: () => Promise<void>;
    catalogMatches: CatalogDocument[];
    getCatalogContext?: () => Promise<{
        catalogMatches: CatalogDocument[];
        visibility: CatalogVisibility;
    }>;
    history?: LlmChatMessage[];
    llm: LlmChatClient;
    maxTurns?: number;
    model: string;
    pinnedContext?: RuntimePinnedContext | null;
    policyToggles: AgentCapabilityToggles;
    principal: AgentPrincipal;
    projectUuid: string;
    runtimeOverrides?: RuntimeOverrides | null;
    skills: OrchestratorSkill[];
    tools: OrchestratorToolExecutor;
}

export type AgentToolDepsForOrchestrator = ToolCatalogAllDeps;

const NEEDS_APPROVAL = new Set<string>([
    'run_sql',
    'schedule_chart_delivery',
    'schedule_dashboard_delivery',
    'upsert_chart_as_code',
    'upsert_dashboard_as_code',
    'upsert_sql_chart_as_code',
]);

const DEFAULT_MAX_TURNS = 8;

const MAX_TOOL_TEXT_CHARS = 4000;
const MAX_ARTIFACT_ROWS = 50;
const MAX_ARTIFACT_COLUMNS = 50;
const MAX_ARTIFACT_CELL_CHARS = 256;
const QUERY_TOOLS = new Set([
    'run_compose_pipeline',
    'run_metric_query',
    'run_saved_chart',
    'run_sql',
    'run_underlying_data',
]);

const catalogVisibilityKey = (visibility: CatalogVisibility): string =>
    JSON.stringify({
        explores: [...visibility.allowedExplores].sort(),
        fields: [...(visibility.allowedFieldsByExplore ?? new Map())]
            .map(([explore, fields]) => [explore, [...fields].sort()])
            .sort(([a], [b]) => String(a).localeCompare(String(b))),
    });

const assertCatalogVisibilityUnchanged = (
    previous: CatalogVisibility | undefined,
    current: CatalogVisibility | undefined,
): void => {
    if (
        previous !== undefined &&
        current !== undefined &&
        catalogVisibilityKey(previous) !== catalogVisibilityKey(current)
    ) {
        throw new Error('Catalog access changed during the turn.');
    }
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

const firstString = (
    record: Record<string, unknown>,
    keys: string[],
): string | undefined => {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value !== '') {
            return value;
        }
    }
    return undefined;
};

const stringArray = (
    record: Record<string, unknown>,
    key: string,
): string[] => {
    const value = record[key];
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
};

const previewCell = (value: unknown): unknown => {
    if (
        value === null ||
        typeof value === 'number' ||
        typeof value === 'boolean'
    ) {
        return value;
    }
    let text: string;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value) ?? String(value);
        } catch {
            text = String(value);
        }
    }
    return text.length > MAX_ARTIFACT_CELL_CHARS
        ? `${text.slice(0, MAX_ARTIFACT_CELL_CHARS)}…`
        : text;
};

const queryPreviewFor = (
    tool: string,
    toolInput: unknown,
    result: Record<string, unknown>,
): QueryArtifactPreview | undefined => {
    if (!QUERY_TOOLS.has(tool)) {
        return undefined;
    }
    const columnsRecord = asRecord(result.columns);
    if (columnsRecord === null || !Array.isArray(result.rows)) {
        return undefined;
    }
    const columns = Object.fromEntries(
        Object.entries(columnsRecord)
            .slice(0, MAX_ARTIFACT_COLUMNS)
            .map(([fieldId, value]) => {
                const column = asRecord(value);
                return [
                    fieldId,
                    {
                        format:
                            column === null
                                ? null
                                : (firstString(column, ['format']) ?? null),
                        label:
                            column === null
                                ? null
                                : (firstString(column, ['label']) ?? null),
                        type:
                            column === null
                                ? null
                                : (firstString(column, ['type']) ?? null),
                    },
                ];
            }),
    );
    const fieldIds = new Set(Object.keys(columns));
    const rows = result.rows.slice(0, MAX_ARTIFACT_ROWS).flatMap((rowValue) => {
        const row = asRecord(rowValue);
        if (row === null) return [];
        return [
            Object.fromEntries(
                Object.entries(row)
                    .filter(([fieldId]) => fieldIds.has(fieldId))
                    .map(([fieldId, cellValue]) => [
                        fieldId,
                        previewCell(cellValue),
                    ]),
            ),
        ];
    });
    const inputRecord = asRecord(toolInput) ?? {};
    return {
        columns,
        dimensions: stringArray(inputRecord, 'dimensions'),
        metrics: stringArray(inputRecord, 'metrics'),
        rows,
    };
};

const artifactKindFor = (tool: string): string => {
    if (tool.includes('dashboard')) {
        return 'dashboard';
    }
    if (tool.includes('chart')) {
        return 'chart';
    }
    if (tool.includes('export') || tool.includes('schedule')) {
        return 'export';
    }
    if (tool.startsWith('run_')) {
        return 'query';
    }
    return 'result';
};

const toArtifact = (
    tool: string,
    result: unknown,
    toolInput: unknown,
): Omit<
    Extract<OrchestratorEvent, { type: 'chart_artifact' }>,
    'type'
> | null => {
    const record = asRecord(result);
    if (record === null) {
        return null;
    }
    const slug = firstString(record, ['slug', 'chartSlug', 'dashboardSlug']);
    const uuid = firstString(record, [
        'uuid',
        'chartUuid',
        'dashboardUuid',
        'queryUuid',
    ]);
    if (slug === undefined && uuid === undefined) {
        return null;
    }
    const preview = queryPreviewFor(tool, toolInput, record);
    return {
        kind: artifactKindFor(tool),
        ...(preview !== undefined ? { preview } : {}),
        ...(slug !== undefined ? { slug } : {}),
        tool,
        ...(uuid !== undefined ? { uuid } : {}),
    };
};

const toUntrustedToolText = (tool: string, result: unknown): string => {
    const serialized = JSON.stringify(result);
    const clipped =
        serialized.length > MAX_TOOL_TEXT_CHARS
            ? `${serialized.slice(0, MAX_TOOL_TEXT_CHARS)}\n[truncated]`
            : serialized;
    return `<untrusted source="tool:${tool}">\n${escapeUntrusted(clipped)}\n</untrusted>`;
};

export const runAgentTurn = async (
    input: OrchestratorDeps & {
        onEvent: (event: OrchestratorEvent) => void;
        resumeApproved?: {
            approvalUuid: string;
            input: unknown;
            tool: string;
        } | null;
        userText: string;
    },
): Promise<OrchestratorOutcome> => {
    const emit = input.onEvent;
    const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
    const usage = { completionTokens: 0, promptTokens: 0 };
    const trackUsage = (delta: {
        completionTokens: number;
        promptTokens: number;
    }): void => {
        usage.completionTokens += delta.completionTokens;
        usage.promptTokens += delta.promptTokens;
    };

    const offered = TOOL_CATALOG.filter(
        (entry) =>
            evaluateCapability(input.principal, entry.capability, {
                toggles: input.policyToggles,
            }).allowed,
    );
    const buildPrompt = (catalogMatches: CatalogDocument[]) =>
        buildSystemPrompt({
            catalogMatches,
            pinnedContext: input.pinnedContext ?? null,
            runtimeOverrides: input.runtimeOverrides ?? null,
            skills: input.skills,
            toolNames: offered.map((entry) => entry.name),
        });
    const llmTools = offered.map((entry) => ({
        description: entry.description,
        inputSchema: z.toJSONSchema(entry.inputSchema) as Record<
            string,
            unknown
        >,
        name: entry.name,
    }));

    const history: LlmChatMessage[] = [
        ...(input.history ?? []),
        { content: input.userText, role: 'user' },
    ];
    let catalogVisibilitySnapshot: CatalogVisibility | undefined;
    let catalogVisibilitySeen = false;
    const refreshCatalogContext = async () => {
        const current = await input.getCatalogContext?.();
        if (catalogVisibilitySeen) {
            assertCatalogVisibilityUnchanged(
                catalogVisibilitySnapshot,
                current?.visibility,
            );
        }
        if (current !== undefined) {
            catalogVisibilitySnapshot = current.visibility;
            catalogVisibilitySeen = true;
        }
        return current;
    };
    emit({ message: 'Starting turn.', type: 'status' });

    const executeAndRecord = async (
        tool: string,
        toolInput: unknown,
        toolCallId: string,
        recordAssistantCall = false,
    ): Promise<{ ok: boolean }> => {
        await input.authorizeContext?.();
        const catalogContext = await refreshCatalogContext();
        emit({ id: toolCallId, input: toolInput, tool, type: 'tool_call' });
        const pushAssistantCallIfNeeded = (): void => {
            if (!recordAssistantCall) {
                return;
            }
            history.push({
                content: null,
                role: 'assistant',
                toolCalls: [
                    {
                        arguments: JSON.stringify(toolInput ?? null),
                        id: toolCallId,
                        name: tool,
                    },
                ],
            });
        };
        let result: unknown;
        try {
            result = await input.tools.execute(
                tool,
                toolInput,
                input.principal,
                catalogContext === undefined
                    ? undefined
                    : { visibility: catalogContext.visibility },
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'Tool failed.';
            emit({ id: toolCallId, ok: false, tool, type: 'tool_result' });
            pushAssistantCallIfNeeded();
            history.push({
                content: `Error: ${message}`,
                role: 'tool',
                toolCallId,
            });
            return { ok: false };
        }
        await input.authorizeContext?.();
        await refreshCatalogContext();
        emit({ id: toolCallId, ok: true, tool, type: 'tool_result' });
        const artifact = toArtifact(tool, result, toolInput);
        if (artifact !== null) {
            emit({ ...artifact, type: 'chart_artifact' });
        }
        pushAssistantCallIfNeeded();
        history.push({
            content: toUntrustedToolText(tool, result),
            role: 'tool',
            toolCallId,
        });
        return { ok: true };
    };

    const suspendForApproval = async (
        tool: string,
        toolInput: unknown,
    ): Promise<OrchestratorOutcome> => {
        await input.authorizeContext?.();
        if (input.approvals === null) {
            const message = `Tool ${tool} needs human approval, which is not configured.`;
            emit({ message, type: 'error' });
            return { status: 'error', text: null, usage: { ...usage } };
        }
        const { approvalUuid } = await input.approvals.requestApproval(
            tool,
            toolInput,
        );
        emit({
            approvalUuid,
            input: toolInput,
            tool,
            type: 'approval_required',
        });
        return {
            approvalUuid,
            status: 'approval_required',
            text: null,
            usage: { ...usage },
        };
    };

    if (input.resumeApproved !== undefined && input.resumeApproved !== null) {
        const resumed = input.resumeApproved;
        await executeAndRecord(
            resumed.tool,
            resumed.input,
            resumed.approvalUuid,
            true,
        );
    }

    let text: string | null = null;
    let turns = 0;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        await input.authorizeContext?.();
        if (turns >= maxTurns) {
            emit({
                status: 'max_turns',
                text,
                type: 'done',
                usage: { ...usage },
            });
            return { status: 'max_turns', text, usage: { ...usage } };
        }
        turns += 1;
        // Sequential: each turn depends on the previous tool results.
        // eslint-disable-next-line no-await-in-loop
        const catalogContext = await refreshCatalogContext();
        // eslint-disable-next-line no-await-in-loop
        const result = await input.llm.complete({
            messages: [
                {
                    content: buildPrompt(
                        catalogContext?.catalogMatches ?? input.catalogMatches,
                    ),
                    role: 'system',
                },
                ...history,
            ],
            model: input.model,
            tools: llmTools.map((tool) => ({
                description: tool.description,
                inputSchema: tool.inputSchema,
                name: tool.name,
            })),
        });
        // eslint-disable-next-line no-await-in-loop
        await input.authorizeContext?.();
        // eslint-disable-next-line no-await-in-loop
        await refreshCatalogContext();
        trackUsage(result.usage);
        if (result.toolCalls.length === 0) {
            text = result.content;
            if (text !== null) {
                emit({ text, type: 'text_delta' });
            }
            emit({
                status: 'completed',
                text,
                type: 'done',
                usage: { ...usage },
            });
            return { status: 'completed', text, usage: { ...usage } };
        }
        history.push({
            content: result.content,
            role: 'assistant',
            toolCalls: result.toolCalls.map((call) => ({
                arguments: call.arguments,
                id: call.id,
                name: call.name,
            })),
        });
        for (const call of result.toolCalls) {
            let parsed: unknown = {};
            try {
                parsed = JSON.parse(call.arguments);
            } catch {
                parsed = {};
            }
            if (NEEDS_APPROVAL.has(call.name)) {
                return suspendForApproval(call.name, parsed);
            }
            // Sequential: tool calls run in order so later calls see earlier results.
            // eslint-disable-next-line no-await-in-loop
            await executeAndRecord(call.name, parsed, call.id);
        }
    }
};
