#!/usr/bin/env node
// MIT MCP stdio entry point: bridges a local MCP client to the backend
// Streamable HTTP endpoint. The backend stays the policy, audit and
// enforcement point; this process only forwards MCP traffic.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export interface StdioCliConfig {
    apiKey: string;
    baseUrl: string;
    projectUuid: string;
}

export const resolveStdioConfig = (env: NodeJS.ProcessEnv): StdioCliConfig => {
    const missing: string[] = [];
    for (const key of [
        'LIGHTDASH_URL',
        'LIGHTDASH_API_KEY',
        'LIGHTDASH_PROJECT_UUID',
    ] as const) {
        const value = env[key];
        if (value === undefined || value === '') {
            missing.push(key);
        }
    }
    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}.`,
        );
    }
    const baseUrl = env.LIGHTDASH_URL ?? '';
    const parsed = (() => {
        try {
            return new URL(baseUrl);
        } catch {
            return null;
        }
    })();
    if (
        parsed === null ||
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    ) {
        throw new Error('LIGHTDASH_URL must be a valid http(s) URL.');
    }
    return {
        apiKey: env.LIGHTDASH_API_KEY ?? '',
        baseUrl,
        projectUuid: env.LIGHTDASH_PROJECT_UUID ?? '',
    };
};

export const buildMcpHttpUrl = (baseUrl: string): string =>
    `${baseUrl.replace(/\/+$/, '')}/api/ext/v1/mcp`;

const buildPreflightUrl = (baseUrl: string): string =>
    `${baseUrl.replace(/\/+$/, '')}/api/ext/v1/preflight`;

export type FetchPreflightFn = (
    url: string,
    init?: { headers?: Record<string, string> },
) => Promise<{ json: () => Promise<unknown>; status: number }>;

export interface PreflightIdentity {
    organizationUuid: string;
    userUuid: string;
}

export const checkBackendPreflight = async ({
    apiKey,
    baseUrl,
    fetchFn = fetch,
}: {
    apiKey: string;
    baseUrl: string;
    fetchFn?: FetchPreflightFn;
}): Promise<PreflightIdentity> => {
    let response;
    try {
        response = await fetchFn(buildPreflightUrl(baseUrl), {
            headers: { Authorization: `ApiKey ${apiKey}` },
        });
    } catch {
        throw new Error(
            'The server check failed: unable to reach the instance.',
        );
    }
    if (response.status === 401) {
        throw new Error('The API key was rejected by the instance.');
    }
    if (response.status === 404) {
        throw new Error('The agent extension is disabled on the instance.');
    }
    if (response.status < 200 || response.status >= 300) {
        throw new Error('The server check failed: unexpected response.');
    }
    const body = (await response.json()) as {
        results?: {
            principal?: {
                organizationUuid?: unknown;
                userUuid?: unknown;
            };
        };
    };
    const principal = body?.results?.principal;
    if (
        typeof principal?.userUuid !== 'string' ||
        principal.userUuid === '' ||
        typeof principal?.organizationUuid !== 'string' ||
        principal.organizationUuid === ''
    ) {
        throw new Error(
            'The server check failed: unrecognized identity response.',
        );
    }
    return {
        organizationUuid: principal.organizationUuid,
        userUuid: principal.userUuid,
    };
};

export const startStdioBridge = async ({
    config,
    connectRemote,
    createStdioTransport = () => new StdioServerTransport(),
}: {
    config: StdioCliConfig;
    connectRemote: (
        client: Client,
        bridgeConfig: StdioCliConfig,
    ) => Promise<void>;
    createStdioTransport?: () => Transport;
}): Promise<{ close: () => Promise<void> }> => {
    const server = new Server(
        { name: 'agent-bi-mcp-stdio', version: '1' },
        { capabilities: { tools: {} } },
    );
    const remote = new Client(
        { name: 'agent-bi-mcp-stdio-bridge', version: '1' },
        { capabilities: {} },
    );
    await connectRemote(remote, config);
    server.setRequestHandler(ListToolsRequestSchema, (request) =>
        remote.listTools(request.params),
    );
    server.setRequestHandler(CallToolRequestSchema, (request) =>
        remote.callTool(request.params),
    );
    await server.connect(createStdioTransport());
    return {
        close: async () => {
            await server.close();
            await remote.close();
        },
    };
};

export const runStdioCli = async (): Promise<void> => {
    const config = resolveStdioConfig(process.env);
    await checkBackendPreflight({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
    });
    await startStdioBridge({
        config,
        connectRemote: (client, bridgeConfig) =>
            client.connect(
                new StreamableHTTPClientTransport(
                    new URL(buildMcpHttpUrl(bridgeConfig.baseUrl)),
                    {
                        requestInit: {
                            headers: {
                                Authorization: `ApiKey ${bridgeConfig.apiKey}`,
                            },
                        },
                    },
                ),
            ),
    });
};
