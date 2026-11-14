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

const positiveInt = (fallback: number) =>
    z.coerce.number().int().positive().default(fallback);

export const agentBiConfigSchema = z.object({
    schema: z.string().trim().min(1).default('agent_ext'),
    llmEndpoint: z.string().trim().min(1).optional(),
    llmApiKey: z.string().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    llmTimeoutMs: positiveInt(60_000),
    maxRows: positiveInt(1000),
    timeoutMs: positiveInt(30_000),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    catalogIndexLimit: positiveInt(2000),
    catalogSearchLimit: positiveInt(8),
    maxTurns: positiveInt(8),
    composeMaxQueries: positiveInt(10),
    metricQueryLimit: positiveInt(100),
    resultsPageSize: positiveInt(500),
    exportPollInitialDelayMs: positiveInt(500),
    exportPollMaxDelayMs: positiveInt(5_000),
    exportPollMaxAttempts: positiveInt(30),
    exportTimeoutMs: positiveInt(60_000),
    v2PollInitialDelayMs: positiveInt(250),
    v2PollMaxDelayMs: positiveInt(5_000),
    v2PollMaxAttempts: positiveInt(60),
});

export type AgentBiConfig = z.output<typeof agentBiConfigSchema>;

export type AgentBiEnv = Record<string, string | undefined>;

export function loadAgentBiConfig(
    env: AgentBiEnv = process.env,
): AgentBiConfig {
    const parsed = agentBiConfigSchema.safeParse({
        schema: emptyToUndefined(env.AGENT_BI_SCHEMA),
        llmEndpoint:
            emptyToUndefined(env.AGENT_BI_LLM_ENDPOINT) ??
            emptyToUndefined(env.AGENT_LLM_BASE_URL),
        llmApiKey:
            emptyToUndefined(env.AGENT_BI_LLM_API_KEY) ??
            emptyToUndefined(env.AGENT_LLM_API_KEY),
        model:
            emptyToUndefined(env.AGENT_BI_MODEL) ??
            emptyToUndefined(env.AGENT_LLM_MODEL),
        llmTimeoutMs:
            emptyToUndefined(env.AGENT_BI_LLM_TIMEOUT_MS) ??
            emptyToUndefined(env.AGENT_LLM_TIMEOUT_MS),
        maxRows: emptyToUndefined(env.AGENT_BI_MAX_ROWS),
        timeoutMs: emptyToUndefined(env.AGENT_BI_TIMEOUT_MS),
        logLevel: emptyToUndefined(env.AGENT_BI_LOG_LEVEL),
        catalogIndexLimit: emptyToUndefined(env.AGENT_BI_CATALOG_INDEX_LIMIT),
        catalogSearchLimit: emptyToUndefined(env.AGENT_BI_CATALOG_SEARCH_LIMIT),
        maxTurns: emptyToUndefined(env.AGENT_BI_MAX_TURNS),
        composeMaxQueries: emptyToUndefined(env.AGENT_BI_COMPOSE_MAX_QUERIES),
        metricQueryLimit: emptyToUndefined(env.AGENT_BI_METRIC_QUERY_LIMIT),
        resultsPageSize: emptyToUndefined(env.AGENT_BI_RESULTS_PAGE_SIZE),
        exportPollInitialDelayMs: emptyToUndefined(
            env.AGENT_BI_EXPORT_POLL_INITIAL_DELAY_MS,
        ),
        exportPollMaxDelayMs: emptyToUndefined(
            env.AGENT_BI_EXPORT_POLL_MAX_DELAY_MS,
        ),
        exportPollMaxAttempts: emptyToUndefined(
            env.AGENT_BI_EXPORT_POLL_MAX_ATTEMPTS,
        ),
        exportTimeoutMs: emptyToUndefined(env.AGENT_BI_EXPORT_TIMEOUT_MS),
        v2PollInitialDelayMs: emptyToUndefined(
            env.AGENT_BI_V2_POLL_INITIAL_DELAY_MS,
        ),
        v2PollMaxDelayMs: emptyToUndefined(env.AGENT_BI_V2_POLL_MAX_DELAY_MS),
        v2PollMaxAttempts: emptyToUndefined(env.AGENT_BI_V2_POLL_MAX_ATTEMPTS),
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
