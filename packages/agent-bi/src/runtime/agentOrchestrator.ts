// Streaming tool-calling loop over the agent tool catalogue. The loop is
// transport-agnostic: it emits events and the host renders them (SSE,
// stdio, tests). Policy stays with the tools; approvals suspend the run.
import { z } from 'zod';
import { getAgentBiConfig } from '../config/agentBiConfig';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import type {
    CatalogDocument,
    CatalogVisibility,
} from '../catalog/catalogIndexer';
import { evaluateCapability } from '../policy/capabilityPolicy';
import type { AgentCapabilityToggles } from '../policy/capabilityPolicy';
import { TOOL_CATALOG, type ToolCatalogAllDeps } from '../tools/toolCatalog';
import {
    assertCatalogVisibilityUnchanged,
    NEEDS_APPROVAL,
    toArtifact,
    toUntrustedToolText,
    type QueryArtifactPreview,
} from './agentOrchestratorHelpers';
import {
    buildSystemPrompt,
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
    const maxTurns = input.maxTurns ?? getAgentBiConfig().maxTurns;
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
