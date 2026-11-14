import { describe, expect, it } from 'vitest';
import {
    getAgentBiConfig,
    loadAgentBiConfig,
    resetAgentBiConfigCache,
} from './agentBiConfig';

describe('loadAgentBiConfig', () => {
    it('applies defaults when no AGENT_BI_* vars are set', () => {
        expect(loadAgentBiConfig({})).toEqual({
            schema: 'agent_ext',
            llmEndpoint: undefined,
            llmApiKey: undefined,
            model: undefined,
            llmTimeoutMs: 60_000,
            maxRows: 1000,
            timeoutMs: 30_000,
            logLevel: 'info',
            catalogIndexLimit: 2000,
            catalogSearchLimit: 8,
            maxTurns: 8,
            composeMaxQueries: 10,
            metricQueryLimit: 100,
            resultsPageSize: 500,
            exportPollInitialDelayMs: 500,
            exportPollMaxDelayMs: 5_000,
            exportPollMaxAttempts: 30,
            exportTimeoutMs: 60_000,
            v2PollInitialDelayMs: 250,
            v2PollMaxDelayMs: 5_000,
            v2PollMaxAttempts: 60,
        });
    });

    it('prefers env values over defaults', () => {
        const config = loadAgentBiConfig({
            AGENT_BI_SCHEMA: 'custom_schema',
            AGENT_BI_LLM_ENDPOINT: 'https://models.example.com/v1',
            AGENT_BI_LLM_API_KEY: 'secret-key',
            AGENT_BI_MODEL: 'example-model',
            AGENT_BI_MAX_ROWS: '50',
            AGENT_BI_TIMEOUT_MS: '5000',
            AGENT_BI_LOG_LEVEL: 'debug',
            AGENT_BI_CATALOG_INDEX_LIMIT: '1500',
            AGENT_BI_CATALOG_SEARCH_LIMIT: '12',
            AGENT_BI_MAX_TURNS: '10',
            AGENT_BI_COMPOSE_MAX_QUERIES: '4',
            AGENT_BI_METRIC_QUERY_LIMIT: '250',
            AGENT_BI_RESULTS_PAGE_SIZE: '200',
            AGENT_BI_EXPORT_POLL_INITIAL_DELAY_MS: '100',
            AGENT_BI_EXPORT_POLL_MAX_DELAY_MS: '2000',
            AGENT_BI_EXPORT_POLL_MAX_ATTEMPTS: '10',
            AGENT_BI_EXPORT_TIMEOUT_MS: '15000',
            AGENT_BI_V2_POLL_INITIAL_DELAY_MS: '100',
            AGENT_BI_V2_POLL_MAX_DELAY_MS: '2500',
            AGENT_BI_V2_POLL_MAX_ATTEMPTS: '20',
            AGENT_LLM_TIMEOUT_MS: '45000',
        });
        expect(config).toEqual({
            schema: 'custom_schema',
            llmEndpoint: 'https://models.example.com/v1',
            llmApiKey: 'secret-key',
            model: 'example-model',
            llmTimeoutMs: 45_000,
            maxRows: 50,
            timeoutMs: 5000,
            logLevel: 'debug',
            catalogIndexLimit: 1500,
            catalogSearchLimit: 12,
            maxTurns: 10,
            composeMaxQueries: 4,
            metricQueryLimit: 250,
            resultsPageSize: 200,
            exportPollInitialDelayMs: 100,
            exportPollMaxDelayMs: 2000,
            exportPollMaxAttempts: 10,
            exportTimeoutMs: 15000,
            v2PollInitialDelayMs: 100,
            v2PollMaxDelayMs: 2500,
            v2PollMaxAttempts: 20,
        });
    });

    it('accepts AGENT_LLM_* env vars when AGENT_BI_* aliases are unset', () => {
        const config = loadAgentBiConfig({
            AGENT_LLM_BASE_URL: 'https://llm.example.com/v1',
            AGENT_LLM_API_KEY: 'llm-key',
            AGENT_LLM_MODEL: 'gpt-4o-mini',
            AGENT_LLM_TIMEOUT_MS: '12000',
        });
        expect(config.llmEndpoint).toBe('https://llm.example.com/v1');
        expect(config.llmApiKey).toBe('llm-key');
        expect(config.model).toBe('gpt-4o-mini');
        expect(config.llmTimeoutMs).toBe(12_000);
    });

    it('treats empty values as unset', () => {
        const config = loadAgentBiConfig({
            AGENT_BI_SCHEMA: '   ',
            AGENT_BI_MAX_ROWS: '',
            AGENT_BI_MODEL: '',
        });
        expect(config.schema).toBe('agent_ext');
        expect(config.maxRows).toBe(1000);
        expect(config.model).toBeUndefined();
    });

    it('throws without leaking values for invalid numbers', () => {
        expect(() => loadAgentBiConfig({ AGENT_BI_MAX_ROWS: 'nope' })).toThrow(
            /Invalid agent-bi configuration: maxRows/,
        );
        expect(() => loadAgentBiConfig({ AGENT_BI_TIMEOUT_MS: '-5' })).toThrow(
            /Invalid agent-bi configuration: timeoutMs/,
        );
    });

    it('throws without leaking values for an invalid log level', () => {
        expect(() =>
            loadAgentBiConfig({ AGENT_BI_LOG_LEVEL: 'verbose' }),
        ).toThrow(/Invalid agent-bi configuration: logLevel/);
    });

    it('never echoes the credential in an error message', () => {
        const secret = 'test-credential-zzz-123';
        let message = '';
        try {
            loadAgentBiConfig({
                AGENT_BI_LLM_API_KEY: secret,
                AGENT_BI_MAX_ROWS: 'bad',
            });
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain('maxRows');
        expect(message).not.toContain(secret);
    });
});

describe('getAgentBiConfig', () => {
    it('caches the config until the cache is reset', () => {
        resetAgentBiConfigCache();
        const first = getAgentBiConfig();
        const second = getAgentBiConfig();
        expect(second).toBe(first);
        resetAgentBiConfigCache();
        expect(getAgentBiConfig()).not.toBe(first);
    });
});
