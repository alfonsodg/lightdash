import { describe, expect, it } from 'vitest';
import * as publicSurface from './index';

describe('package public surface', () => {
    it('exposes the config API', () => {
        expect(typeof publicSurface.loadAgentBiConfig).toBe('function');
        expect(typeof publicSurface.getAgentBiConfig).toBe('function');
        expect(typeof publicSurface.resetAgentBiConfigCache).toBe('function');
        expect(publicSurface.agentBiConfigSchema).toBeDefined();
    });

    it('exposes the logger API', () => {
        expect(typeof publicSurface.createLogger).toBe('function');
    });

    it('exposes the auth, policy, guardrails and audit APIs', () => {
        expect(typeof publicSurface.resolveAgentPrincipal).toBe('function');
        expect(typeof publicSurface.evaluateCapability).toBe('function');
        expect(typeof publicSurface.evaluateSqlGuard).toBe('function');
        expect(typeof publicSurface.recordAuditEvent).toBe('function');
    });

    it('exposes the catalog, client and tools APIs', () => {
        expect(typeof publicSurface.buildCatalogDocuments).toBe('function');
        expect(typeof publicSurface.createLightdashV2Client).toBe('function');
        expect(typeof publicSurface.createAgentTools).toBe('function');
        expect(Array.isArray(publicSurface.AGENT_TOOL_NAMES)).toBe(true);
    });

    it('exposes the content and export APIs', () => {
        expect(typeof publicSurface.createContentTools).toBe('function');
        expect(typeof publicSurface.createExportTools).toBe('function');
        expect(typeof publicSurface.createContentFetchClient).toBe('function');
        expect(typeof publicSurface.createExportFetchClient).toBe('function');
    });
});
