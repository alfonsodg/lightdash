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
});
