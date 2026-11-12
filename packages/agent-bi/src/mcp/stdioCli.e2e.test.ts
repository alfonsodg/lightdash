// Slice 4: the built CLI binary over a real StdioClientTransport against a
// loopback MCP backend (raw node:http, no extra deps).
// Requires dist (pnpm -F agent-bi build).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const distBin = resolve('dist/mcp/stdioBin.js');

const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolveBody, rejectBody) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (error) {
                rejectBody(error);
            }
        });
        req.on('error', rejectBody);
    });

const createRemote = (): McpServer => {
    const remote = new McpServer({ name: 'fake-loopback', version: '1' });
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
    return remote;
};

describe('built stdio CLI end to end', () => {
    it(
        'proxies tools/list and tools/call to the loopback backend',
        { timeout: 30_000 },
        async () => {
            if (!existsSync(distBin)) {
                throw new Error(
                    'Missing CLI build output: run pnpm -F agent-bi build first.',
                );
            }
            const server = createServer(async (req, res) => {
                try {
                    if (
                        req.method === 'GET' &&
                        req.url === '/api/ext/v1/preflight'
                    ) {
                        res.setHeader('content-type', 'application/json');
                        res.end(
                            JSON.stringify({
                                results: {
                                    principal: {
                                        authType: 'pat',
                                        cacheKey: 'e2e-key',
                                        organizationUuid: 'org-1',
                                        userAttributesHash: 'abcd1234',
                                        userUuid:
                                            '11111111-1111-4111-8111-111111111111',
                                    },
                                },
                                status: 'ok',
                            }),
                        );
                        return;
                    }
                    if (
                        req.method === 'POST' &&
                        req.url === '/api/ext/v1/mcp'
                    ) {
                        const transport = new StreamableHTTPServerTransport({
                            enableJsonResponse: true,
                            sessionIdGenerator: undefined,
                        });
                        await createRemote().connect(transport);
                        await transport.handleRequest(
                            req,
                            res,
                            await readJsonBody(req),
                        );
                        return;
                    }
                    res.statusCode = 404;
                    res.end();
                } catch {
                    res.statusCode = 500;
                    res.end();
                }
            });
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            const transport = new StdioClientTransport({
                args: [distBin],
                command: process.execPath,
                env: {
                    ...process.env,
                    LIGHTDASH_API_KEY: 'test-pat',
                    LIGHTDASH_PROJECT_UUID:
                        '22222222-2222-4222-8222-222222222222',
                    LIGHTDASH_URL: base,
                },
                stderr: 'pipe',
            });
            const client = new Client(
                { name: 'e2e-client', version: '1' },
                { capabilities: {} },
            );
            await client.connect(transport);
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
                await new Promise<void>((resolveClose, rejectClose) => {
                    server.close((error) =>
                        error ? rejectClose(error) : resolveClose(),
                    );
                });
            }
        },
    );
});
