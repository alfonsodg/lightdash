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
            const choice = completion.choices[0];
            if (choice === undefined) {
                throw new LlmChatError(
                    'UPSTREAM_ERROR',
                    'The model returned no choices.',
                );
            }
            const toolCalls = (choice.message.tool_calls ?? [])
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
                }));
            return {
                content: choice.message.content,
                finishReason: choice.finish_reason,
                toolCalls,
                usage: {
                    completionTokens: completion.usage?.completion_tokens ?? 0,
                    promptTokens: completion.usage?.prompt_tokens ?? 0,
                },
            };
        },
    };
};
