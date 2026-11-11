import { z } from 'zod';

// Operational configuration only (no rollout flag): scope is the database
// schema name, the LLM endpoint/credentials/model, and row/timeout caps.
// Precedence is AGENT_BI_* env vars over the defaults below; the config is
// read once at startup, so env changes require a process restart.
const emptyToUndefined = (value: string | undefined): string | undefined => {
    if (value === undefined) {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? value : undefined;
};

export const agentBiConfigSchema = z.object({
    schema: z.string().trim().min(1).default('agent_ext'),
    llmEndpoint: z.string().trim().min(1).optional(),
    llmApiKey: z.string().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    maxRows: z.coerce.number().int().positive().default(1000),
    timeoutMs: z.coerce.number().int().positive().default(30_000),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AgentBiConfig = z.output<typeof agentBiConfigSchema>;

export type AgentBiEnv = Record<string, string | undefined>;

export function loadAgentBiConfig(
    env: AgentBiEnv = process.env,
): AgentBiConfig {
    const parsed = agentBiConfigSchema.safeParse({
        schema: emptyToUndefined(env.AGENT_BI_SCHEMA),
        llmEndpoint: emptyToUndefined(env.AGENT_BI_LLM_ENDPOINT),
        llmApiKey: emptyToUndefined(env.AGENT_BI_LLM_API_KEY),
        model: emptyToUndefined(env.AGENT_BI_MODEL),
        maxRows: emptyToUndefined(env.AGENT_BI_MAX_ROWS),
        timeoutMs: emptyToUndefined(env.AGENT_BI_TIMEOUT_MS),
        logLevel: emptyToUndefined(env.AGENT_BI_LOG_LEVEL),
    });
    if (!parsed.success) {
        const details = parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.code}`)
            .join('; ');
        throw new Error(`Invalid agent-bi configuration: ${details}`);
    }
    return parsed.data;
}

let cachedConfig: AgentBiConfig | undefined;

export function getAgentBiConfig(): AgentBiConfig {
    if (!cachedConfig) {
        cachedConfig = loadAgentBiConfig();
    }
    return cachedConfig;
}

export function resetAgentBiConfigCache(): void {
    cachedConfig = undefined;
}
