// Clean-room MIT MCP server over the Phase 3-4 tool layer.
//
// One MCP tool per agent-bi tool whose capability the principal holds.
// Execution delegates to the owning module through the shared catalogue,
// so policy gating, guards and audit rows stay identical everywhere.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { evaluateCapability } from '../policy/capabilityPolicy';
import { AgentToolError } from '../tools/agentToolTypes';
import {
    createToolCatalog,
    TOOL_CATALOG,
    type ToolCatalogAllDeps,
} from '../tools/toolCatalog';

export type McpServerDeps = ToolCatalogAllDeps;

export interface McpServerInfo {
    name: string;
    version: string;
}

const DEFAULT_SERVER_INFO: McpServerInfo = {
    name: 'agent-bi-mcp',
    version: '1',
};

const toRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { value };

export const createAgentBiMcpServer = ({
    deps,
    principal,
    serverInfo = DEFAULT_SERVER_INFO,
}: {
    deps: McpServerDeps;
    principal: AgentPrincipal;
    serverInfo?: McpServerInfo;
}): McpServer => {
    const server = new McpServer({
        name: serverInfo.name,
        version: serverInfo.version,
    });
    const catalog = createToolCatalog(deps);

    const visibleTools = TOOL_CATALOG.filter(
        (entry) =>
            evaluateCapability(principal, entry.capability, deps.policyContext)
                .allowed,
    );
    for (const entry of visibleTools) {
        const inputSchema: z.ZodObject<z.ZodRawShape> = entry.inputSchema;
        server.registerTool(
            entry.name,
            { description: entry.description, inputSchema },
            async (args) => {
                try {
                    const result = await catalog.execute(
                        entry.name,
                        args,
                        principal,
                    );
                    return {
                        content: [
                            {
                                text: `### ${entry.name}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
                                type: 'text' as const,
                            },
                        ],
                        structuredContent: toRecord(result),
                    };
                } catch (error) {
                    const text =
                        error instanceof AgentToolError
                            ? error.message
                            : 'The tool failed to execute.';
                    return {
                        content: [{ text, type: 'text' as const }],
                        isError: true as const,
                    };
                }
            },
        );
    }

    return server;
};
