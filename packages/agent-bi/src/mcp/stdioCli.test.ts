// Slice 2 (TDD): stdio bridge resolves env, gates on preflight, and forwards
// tools/list + tools/call to the backend MCP endpoint. No network here:
// the remote end is an in-memory MCP server.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    buildMcpHttpUrl,
    checkBackendPreflight,
    resolveStdioConfig,
    startStdioBridge,
} from './stdioCli';

const baseEnv = (): Record<string, string> => ({
    LIGHTDASH_API_KEY: 'test-pat-value',
    LIGHTDASH_PROJECT_UUID: '22222222-2222-4222-8222-222222222222',
    LIGHTDASH_URL: 'https://instance.example',
});

describe('stdio bridge config', () => {
    it('rejects missing variables by name without leaking values', () => {
        expect(() => resolveStdioConfig({})).toThrow(/LIGHTDASH_URL/);
        expect(() => resolveStdioConfig({})).toThrow(/LIGHTDASH_API_KEY/);
        expect(() => resolveStdioConfig({})).toThrow(/LIGHTDASH_PROJECT_UUID/);
        expect(() => resolveStdioConfig({})).not.toThrow(/test-pat-value/);
        expect(() =>
            resolveStdioConfig({ ...baseEnv(), LIGHTDASH_URL: '' }),
        ).toThrow(/LIGHTDASH_URL/);
    });

    it('joins the MCP endpoint without duplicate slashes', () => {
        expect(buildMcpHttpUrl('https://instance.example')).toBe(
            'https://instance.example/api/ext/v1/mcp',
        );
        expect(buildMcpHttpUrl('https://instance.example/')).toBe(
            'https://instance.example/api/ext/v1/mcp',
        );
    });
});

describe('preflight gate', () => {
    it('returns the principal identity on success', async () => {
        const seen: Array<{ headers: unknown; url: string }> = [];
        const fetchFn = async (
            url: string,
            init?: { headers?: Record<string, string> },
        ): Promise<{ json: () => Promise<unknown>; status: number }> => {
            seen.push({ headers: init?.headers, url });
            return {
                json: async () => ({
                    results: {
                        principal: {
                            authType: 'pat',
                            cacheKey: 'preflight-key',
                            organizationUuid: 'org-1',
                            userAttributesHash: 'abcd1234',
                            userUuid: 'user-1',
                        },
                    },
                    status: 'ok',
                }),
                status: 200,
            };
        };
        const identity = await checkBackendPreflight({
            apiKey: 'test-pat-value',
            baseUrl: 'https://instance.example',
            fetchFn,
        });
        expect(identity.userUuid).toBe('user-1');
        expect(seen).toHaveLength(1);
        expect(seen[0]?.url).toBe(
            'https://instance.example/api/ext/v1/preflight',
        );
        expect(JSON.stringify(seen[0]?.headers)).toContain('test-pat-value');
    });

    it('rejects invalid tokens and disabled extensions without leaking the key', async () => {
        const fetchFn = (status: number) => async () => ({ status });
        await expect(
            checkBackendPreflight({
                apiKey: 'test-pat-value',
                baseUrl: 'https://instance.example',
                fetchFn: fetchFn(401) as never,
            }),
        ).rejects.toThrow(/rejected/);
        await expect(
            checkBackendPreflight({
                apiKey: 'test-pat-value',
                baseUrl: 'https://instance.example',
                fetchFn: fetchFn(404) as never,
            }),
        ).rejects.toThrow(/disabled/);
    });
});

describe('stdio bridge forwarding', () => {
    it('proxies tools/list and tools/call to the remote server', async () => {
        const remote = new McpServer({ name: 'fake-remote', version: '1' });
        remote.registerTool(
            'echo_tool',
            {
                description: 'Echoes text.',
                inputSchema: { text: z.string() },
            },
            async ({ text }) => ({
                content: [{ text: String(text), type: 'text' as const }],
            }),
        );
        const [remoteClientTransport, remoteServerTransport] =
            InMemoryTransport.createLinkedPair();
        const [bridgeTransport, clientTransport] =
            InMemoryTransport.createLinkedPair();
        await remote.connect(remoteServerTransport);
        const { close } = await startStdioBridge({
            config: resolveStdioConfig(baseEnv()),
            connectRemote: (client) => client.connect(remoteClientTransport),
            createStdioTransport: () => bridgeTransport,
        });
        const client = new Client(
            { name: 'test-client', version: '1' },
            { capabilities: {} },
        );
        await client.connect(clientTransport);
        try {
            const listed = await client.listTools();
            expect(listed.tools.map((tool) => tool.name)).toEqual([
                'echo_tool',
            ]);
            const called = await client.callTool({
                arguments: { text: 'hello' },
                name: 'echo_tool',
            });
            expect(called).toMatchObject({
                content: [{ text: 'hello', type: 'text' }],
            });
        } finally {
            await client.close();
            await close();
            await remote.close();
        }
    });
});
