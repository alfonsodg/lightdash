// Agent tool registry (Slice C): discovery + governed query tools behind
// one executor. Unknown names reject; every execution is capability-gated
// and audit-logged by the owning module.

import type { AgentPrincipal } from '../auth/agentPrincipal';
import { AgentToolError, type AgentToolRuntimeOptions } from './agentToolTypes';
import {
    createDiscoveryTools,
    DISCOVERY_TOOL_NAMES,
    type DiscoveryToolDeps,
    type DiscoveryToolName,
} from './discoveryTools';
import {
    createQueryTools,
    QUERY_TOOL_NAMES,
    type QueryToolDeps,
    type QueryToolName,
} from './queryTools';

export * from './agentToolTypes';
export * from './discoveryTools';
export * from './queryTools';
export * from './toolCatalog';

export const AGENT_TOOL_NAMES = [
    ...DISCOVERY_TOOL_NAMES,
    ...QUERY_TOOL_NAMES,
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export const isAgentToolName = (value: string): value is AgentToolName =>
    (AGENT_TOOL_NAMES as readonly string[]).includes(value);

export type AgentToolsDeps = DiscoveryToolDeps & QueryToolDeps;

export const createAgentTools = (deps: AgentToolsDeps) => {
    const discovery = createDiscoveryTools(deps);
    const query = createQueryTools(deps);

    const executeTool = async (
        toolName: string,
        rawInput: unknown,
        principal: AgentPrincipal,
        options: AgentToolRuntimeOptions = {},
    ): Promise<unknown> => {
        if ((DISCOVERY_TOOL_NAMES as readonly string[]).includes(toolName)) {
            return discovery.executeTool(
                toolName as DiscoveryToolName,
                rawInput,
                principal,
                options,
            );
        }
        if ((QUERY_TOOL_NAMES as readonly string[]).includes(toolName)) {
            return query.executeTool(
                toolName as QueryToolName,
                rawInput,
                principal,
                options,
            );
        }
        throw new AgentToolError(
            'UNKNOWN_TOOL',
            `Tool "${toolName}" is not recognized.`,
        );
    };

    return {
        discovery,
        executeTool,
        query,
        toolNames: AGENT_TOOL_NAMES,
    };
};
