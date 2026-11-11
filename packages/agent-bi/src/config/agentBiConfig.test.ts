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
            maxRows: 1000,
            timeoutMs: 30_000,
            logLevel: 'info',
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
        });
        expect(config).toEqual({
            schema: 'custom_schema',
            llmEndpoint: 'https://models.example.com/v1',
            llmApiKey: 'secret-key',
            model: 'example-model',
            maxRows: 50,
            timeoutMs: 5000,
            logLevel: 'debug',
        });
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
