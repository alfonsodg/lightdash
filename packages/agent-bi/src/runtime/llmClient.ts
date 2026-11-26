// OpenAI-compatible chat client (Ollama, vLLM, LiteLLM, OpenRouter,
// OpenAI). Transport-agnostic: tests inject fetch, production passes
// credentials for the configured endpoint only.
import OpenAI from 'openai';
import type {
    ChatCompletionAssistantMessageParam,
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from 'openai/resources/chat/completions';

export interface LlmChatMessage {
    content: string | null;
    role: 'assistant' | 'system' | 'tool' | 'user';
    toolCallId?: string;
    toolCalls?: Array<{ arguments: string; id: string; name: string }>;
}

export interface LlmChatTool {
    description: string;
    inputSchema: Record<string, unknown>;
    name: string;
}

export interface LlmUsage {
    completionTokens: number;
    promptTokens: number;
}

export interface LlmChatResult {
    content: string | null;
    finishReason: string;
    toolCalls: Array<{ arguments: string; id: string; name: string }>;
    usage: LlmUsage;
}

export type LlmChatErrorCode = 'UPSTREAM_ERROR';

export class LlmChatError extends Error {
    readonly code: LlmChatErrorCode;

    constructor(code: LlmChatErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = 'LlmChatError';
    }
}

export interface LlmChatClient {
    complete(input: {
        maxTokens?: number;
        messages: LlmChatMessage[];
        model?: string;
        signal?: AbortSignal | null;
        tools?: LlmChatTool[];
    }): Promise<LlmChatResult>;
}

const toSdkMessage = (message: LlmChatMessage): ChatCompletionMessageParam => {
    if (message.role === 'assistant' && message.toolCalls !== undefined) {
        const assistant: ChatCompletionAssistantMessageParam = {
            content: message.content,
            role: 'assistant',
            tool_calls: message.toolCalls.map((call) => ({
                function: {
                    arguments: call.arguments,
                    name: call.name,
                },
                id: call.id,
                type: 'function' as const,
            })),
        };
        return assistant;
    }
    if (message.role === 'tool') {
        return {
            content: message.content ?? '',
            role: 'tool',
            tool_call_id: message.toolCallId ?? '',
        };
    }
    return { content: message.content ?? '', role: message.role };
};

const toSdkTool = (tool: LlmChatTool): ChatCompletionTool => ({
    function: {
        description: tool.description,
        name: tool.name,
        parameters: tool.inputSchema,
    },
    type: 'function',
});

const isOrchestratorChatEndpoint = (baseUrl: string): boolean =>
    /\/api\/v1\/chat(?:\/stream)?$/i.test(baseUrl) || /:8801(?:\/|$)/.test(baseUrl);

const resolveOrchestratorChatUrl = (baseUrl: string): string =>
    /\/api\/v1\/chat$/i.test(baseUrl)
        ? baseUrl
        : `${baseUrl.replace(/\/api\/v1\/chat\/stream$/i, '')}/api/v1/chat`;

const buildOrchestratorPromptAndContext = (
    messages: LlmChatMessage[],
    tools?: LlmChatTool[],
): { context: string; prompt: string } => {
    const systemParts = messages
        .filter((m) => m.role === 'system' && m.content)
        .map((m) => m.content ?? '');
    const historyLines = messages
        .filter((m) => m.role !== 'system')
        .map((m) => {
            if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
                return `ASSISTANT_TOOL_CALL: ${JSON.stringify(m.toolCalls)}`;
            }
            if (m.role === 'tool') {
                return `TOOL_RESULT (${m.toolCallId ?? ''}): ${m.content ?? ''}`;
            }
            return `${m.role.toUpperCase()}: ${m.content ?? ''}`;
        });

    const hasTools = tools !== undefined && tools.length > 0;
    const toolSpec = hasTools
        ? `\nAVAILABLE_TOOLS:\n${JSON.stringify(
              tools.map((t) => ({
                  description: t.description,
                  name: t.name,
                  parameters: t.inputSchema,
              })),
          )}\nRespond ONLY with valid JSON: either {"tool_call":{"name":"<tool>","arguments":{...}}} or {"final_answer":"<markdown_response>"}.`
        : '';

    const context = [...systemParts, ...historyLines.slice(0, -1), toolSpec]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 180_000);

    const lastMsg = messages.at(-1);
    const prompt = (
        lastMsg?.role === 'tool'
            ? `Continue using TOOL_RESULT (${lastMsg.toolCallId ?? ''}): ${lastMsg.content ?? ''}`
            : (lastMsg?.content ?? 'Analyze the provided context.')
    ).slice(0, 7800);

    return { context, prompt };
};

const parseOrchestratorAnswer = (
    answer: string,
    hasTools: boolean,
): LlmChatResult => {
    if (hasTools) {
        try {
            const cleaned = answer
                .trim()
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/\s*```$/, '');
            const parsed = JSON.parse(cleaned) as {
                final_answer?: unknown;
                tool_call?: { arguments?: unknown; name?: unknown };
            };
            if (
                parsed.tool_call &&
                typeof parsed.tool_call.name === 'string' &&
                parsed.tool_call.name.length > 0
            ) {
                return {
                    content: null,
                    finishReason: 'tool_calls',
                    toolCalls: [
                        {
                            arguments: JSON.stringify(
                                parsed.tool_call.arguments ?? {},
                            ),
                            id: `orch_${Date.now()}`,
                            name: parsed.tool_call.name,
                        },
                    ],
                    usage: { completionTokens: 0, promptTokens: 0 },
                };
            }
            if (typeof parsed.final_answer === 'string') {
                return {
                    content: parsed.final_answer,
                    finishReason: 'stop',
                    toolCalls: [],
                    usage: { completionTokens: 0, promptTokens: 0 },
                };
            }
        } catch {
            // Fall back to returning raw text answer.
        }
    }
    return {
        content: answer,
        finishReason: 'stop',
        toolCalls: [],
        usage: { completionTokens: 0, promptTokens: 0 },
    };
};

const createOrchestratorChatClient = (options: {
    apiKey: string;
    baseUrl: string;
    fetchImpl?: typeof globalThis.fetch;
    timeoutMs?: number;
}): LlmChatClient => {
    const endpoint = resolveOrchestratorChatUrl(options.baseUrl);
    const fetchFn = options.fetchImpl ?? globalThis.fetch;
    return {
        complete: async (input) => {
            const hasTools =
                input.tools !== undefined && input.tools.length > 0;
            const { context, prompt } = buildOrchestratorPromptAndContext(
                input.messages,
                input.tools,
            );
            const timeoutController =
                options.timeoutMs && options.timeoutMs > 0
                    ? AbortSignal.timeout(options.timeoutMs)
                    : undefined;
            const signal = input.signal
                ? timeoutController
                    ? AbortSignal.any([input.signal, timeoutController])
                    : input.signal
                : timeoutController;

            let response: Response;
            try {
                response = await fetchFn(endpoint, {
                    body: JSON.stringify({
                        consumer: 'isp',
                        context,
                        profile: 'default',
                        prompt,
                        response_format: hasTools ? 'json_object' : 'text',
                    }),
                    headers: {
                        'content-type': 'application/json',
                        'x-api-key': options.apiKey,
                    },
                    method: 'POST',
                    signal,
                });
            } catch (error) {
                if (
                    typeof DOMException !== 'undefined' &&
                    error instanceof DOMException &&
                    error.name === 'AbortError'
                ) {
                    throw error;
                }
                const message =
                    error instanceof Error && error.message !== ''
                        ? error.message
                        : 'The orchestrator request failed.';
                throw new LlmChatError('UPSTREAM_ERROR', message);
            }

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new LlmChatError(
                    'UPSTREAM_ERROR',
                    `Orchestrator HTTP ${response.status}: ${body || response.statusText}`,
                );
            }
            const payload = (await response.json()) as {
                answer?: unknown;
            };
            const answer =
                typeof payload.answer === 'string' ? payload.answer : '';
            return parseOrchestratorAnswer(answer, hasTools);
        },
    };
};

export const createOpenAiChatClient = (options: {
    apiKey: string;
    baseUrl: string;
    fetchImpl?: typeof globalThis.fetch;
    model?: string;
    timeoutMs?: number;
}): LlmChatClient => {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    if (baseUrl === '') {
        throw new LlmChatError(
            'UPSTREAM_ERROR',
            'Missing AGENT_LLM_BASE_URL for the model endpoint.',
        );
    }
    if (options.apiKey === '') {
        throw new LlmChatError(
            'UPSTREAM_ERROR',
            'Missing AGENT_LLM_API_KEY for the model endpoint.',
        );
    }
    if (isOrchestratorChatEndpoint(baseUrl)) {
        return createOrchestratorChatClient({
            apiKey: options.apiKey,
            baseUrl,
            fetchImpl: options.fetchImpl,
            timeoutMs: options.timeoutMs,
        });
    }
    const client = new OpenAI({
        apiKey: options.apiKey,
        baseURL: baseUrl,
        fetch: options.fetchImpl,
        maxRetries: 0,
        timeout: options.timeoutMs,
    });
    return {
        complete: async (input) => {
            const model = input.model ?? options.model;
            if (model === undefined || model === '') {
                throw new LlmChatError(
                    'UPSTREAM_ERROR',
                    'Missing AGENT_LLM_MODEL for the model endpoint.',
                );
            }
            let completion;
            try {
                completion = await client.chat.completions.create(
                    {
                        max_tokens: input.maxTokens,
                        messages: input.messages.map(toSdkMessage),
                        model,
                        stream: false,
                        tools:
                            input.tools !== undefined && input.tools.length > 0
                                ? input.tools.map(toSdkTool)
                                : undefined,
                    },
                    { signal: input.signal ?? undefined },
                );
            } catch (error) {
                if (
                    typeof DOMException !== 'undefined' &&
                    error instanceof DOMException &&
                    error.name === 'AbortError'
                ) {
                    throw error;
                }
                const message =
                    error instanceof Error && error.message !== ''
                        ? error.message
                        : 'The model request failed.';
                throw new LlmChatError('UPSTREAM_ERROR', message);
            }
            if (completion.choices.length === 0) {
                throw new LlmChatError(
                    'UPSTREAM_ERROR',
                    'The model returned no choices.',
                );
            }
            const toolCalls = completion.choices.flatMap((choice) =>
                (choice.message.tool_calls ?? [])
                    .filter(
                        (
                            call,
                        ): call is Extract<typeof call, { type: 'function' }> =>
                            call.type === 'function',
                    )
                    .map((call) => ({
                        arguments: call.function.arguments,
                        id: call.id,
                        name: call.function.name,
                    })),
            );
            const contentParts = completion.choices
                .map((choice) => choice.message.content)
                .filter(
                    (part): part is string =>
                        typeof part === 'string' && part.length > 0,
                );
            const toolChoice = completion.choices.find(
                (choice) => (choice.message.tool_calls?.length ?? 0) > 0,
            );
            const finishReason =
                toolChoice?.finish_reason ??
                completion.choices.at(-1)?.finish_reason ??
                completion.choices[0].finish_reason;
            return {
                content:
                    contentParts.length > 0 ? contentParts.join('\n') : null,
                finishReason,
                toolCalls,
                usage: {
                    completionTokens: completion.usage?.completion_tokens ?? 0,
                    promptTokens: completion.usage?.prompt_tokens ?? 0,
                },
            };
        },
    };
};
