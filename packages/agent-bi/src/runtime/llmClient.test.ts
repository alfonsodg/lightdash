// Slice 2 (TDD red): OpenAI-compatible chat client over injectable fetch.
import { describe, expect, it } from 'vitest';
import { createOpenAiChatClient } from './llmClient';

const chatCompletion = (message: unknown) =>
    new Response(
        JSON.stringify({
            choices: [
                {
                    finish_reason: 'tool_calls',
                    index: 0,
                    message,
                },
            ],
            created: 1,
            id: 'chatcmpl-1',
            model: 'mock-model',
            object: 'chat.completion',
            usage: { completion_tokens: 5, prompt_tokens: 10 },
        }),
        {
            headers: { 'content-type': 'application/json' },
            status: 200,
        },
    );

const setup = (message: unknown) => {
    const seen: Array<{ body: unknown; url: string }> = [];
    const fetchImpl = async (
        url: string | URL | Request,
        init?: RequestInit,
    ) => {
        seen.push({
            body:
                typeof init?.body === 'string'
                    ? JSON.parse(init.body)
                    : init?.body,
            url: String(url),
        });
        return chatCompletion(message);
    };
    const client = createOpenAiChatClient({
        apiKey: 'test-key',
        baseUrl: 'https://llm.example',
        fetchImpl,
        model: 'mock-model',
    });
    return { client, seen };
};

describe('openai chat client', () => {
    it('rejects missing endpoint and key', () => {
        expect(() =>
            createOpenAiChatClient({ apiKey: '', baseUrl: '' }),
        ).toThrow(/AGENT_LLM_BASE_URL/);
        expect(() =>
            createOpenAiChatClient({
                apiKey: '',
                baseUrl: 'https://x.example',
            }),
        ).toThrow(/AGENT_LLM_API_KEY/);
    });

    it('maps tool calls and usage from the wire', async () => {
        const { client, seen } = setup({
            content: null,
            role: 'assistant',
            tool_calls: [
                {
                    function: {
                        arguments: '{"projectUuid":"p"}',
                        name: 'list_explores',
                    },
                    id: 'call_1',
                    type: 'function',
                },
            ],
        });
        const result = await client.complete({
            messages: [{ content: 'hi', role: 'user' }],
            tools: [
                {
                    description: 'Lists explores.',
                    inputSchema: { type: 'object' },
                    name: 'list_explores',
                },
            ],
        });
        expect(result.toolCalls).toEqual([
            {
                arguments: '{"projectUuid":"p"}',
                id: 'call_1',
                name: 'list_explores',
            },
        ]);
        expect(result.usage).toEqual({
            completionTokens: 5,
            promptTokens: 10,
        });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.url).toContain('https://llm.example');
    });

    it('returns assistant text when there are no tool calls', async () => {
        const { client } = setup({
            content: 'Hello there.',
            role: 'assistant',
        });
        const result = await client.complete({
            messages: [{ content: 'hi', role: 'user' }],
        });
        expect(result.content).toBe('Hello there.');
        expect(result.toolCalls).toEqual([]);
    });

    it('lets abort errors through', async () => {
        const { client } = setup({
            content: 'Hello there.',
            role: 'assistant',
        });
        const controller = new AbortController();
        controller.abort();
        await expect(
            client.complete({
                messages: [{ content: 'hi', role: 'user' }],
                signal: controller.signal,
            }),
        ).rejects.toThrow();
    });

    it('aggregates text and tool_calls across multiple choices', async () => {
        const client = createOpenAiChatClient({
            apiKey: 'test-key',
            baseUrl: 'https://llm.example',
            fetchImpl: async () =>
                new Response(
                    JSON.stringify({
                        choices: [
                            {
                                index: 0,
                                message: {
                                    content: 'Inspecting orders first.',
                                    role: 'assistant',
                                },
                            },
                            {
                                finish_reason: 'tool_calls',
                                index: 1,
                                message: {
                                    role: 'assistant',
                                    tool_calls: [
                                        {
                                            function: {
                                                arguments:
                                                    '{"exploreId":"orders","projectUuid":"p"}',
                                                name: 'get_explore',
                                            },
                                            id: 'call_2',
                                            type: 'function',
                                        },
                                    ],
                                },
                            },
                        ],
                        created: 1,
                        id: 'chatcmpl-split',
                        model: 'deepseek-v4.1-flash',
                        object: 'chat.completion',
                        usage: { completion_tokens: 15, prompt_tokens: 20 },
                    }),
                    {
                        headers: { 'content-type': 'application/json' },
                        status: 200,
                    },
                ),
            model: 'deepseek-v4.1-flash',
        });

        const result = await client.complete({
            messages: [{ content: 'hi', role: 'user' }],
        });
        expect(result.content).toBe('Inspecting orders first.');
        expect(result.finishReason).toBe('tool_calls');
        expect(result.toolCalls).toEqual([
            {
                arguments: '{"exploreId":"orders","projectUuid":"p"}',
                id: 'call_2',
                name: 'get_explore',
            },
        ]);
    });

    it('routes through ai-orchestrator-chat with x-api-key and parses tool_call and final_answer', async () => {
        const calls: Array<{ headers: unknown; url: string; body: string }> = [];
        let turn = 0;
        const client = createOpenAiChatClient({
            apiKey: 'isp-secret-key',
            baseUrl: 'http://127.0.0.1:8801',
            fetchImpl: async (input, init) => {
                turn += 1;
                calls.push({
                    body: String(init?.body ?? ''),
                    headers: init?.headers,
                    url: String(input),
                });
                const answer =
                    turn === 1
                        ? JSON.stringify({
                              tool_call: {
                                  arguments: { projectUuid: 'p1' },
                                  name: 'list_explores',
                              },
                          })
                        : JSON.stringify({
                              final_answer: 'Hay 7 explores disponibles.',
                          });
                return new Response(
                    JSON.stringify({
                        answer,
                        answer_status: 'generated',
                        answer_timing_ms: 42.1,
                    }),
                    {
                        headers: { 'content-type': 'application/json' },
                        status: 200,
                    },
                );
            },
        });

        const first = await client.complete({
            messages: [{ content: 'Lista explores', role: 'user' }],
            tools: [
                {
                    description: 'List project explores',
                    inputSchema: { type: 'object' },
                    name: 'list_explores',
                },
            ],
        });
        expect(calls[0].url).toBe('http://127.0.0.1:8801/api/v1/chat');
        expect(calls[0].headers).toEqual(
            expect.objectContaining({ 'x-api-key': 'isp-secret-key' }),
        );
        expect(JSON.parse(calls[0].body)).toEqual(
            expect.objectContaining({ consumer: 'isp', response_format: 'json_object' }),
        );
        expect(first.finishReason).toBe('tool_calls');
        expect(first.toolCalls[0].name).toBe('list_explores');

        const second = await client.complete({
            messages: [
                { content: 'Lista explores', role: 'user' },
                { content: 'ok', role: 'tool', toolCallId: 'orch_1' },
            ],
            tools: [
                {
                    description: 'List project explores',
                    inputSchema: { type: 'object' },
                    name: 'list_explores',
                },
            ],
        });
        expect(second.finishReason).toBe('stop');
        expect(second.content).toBe('Hay 7 explores disponibles.');
    });
});
