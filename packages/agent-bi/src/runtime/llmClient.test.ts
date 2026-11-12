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
});
