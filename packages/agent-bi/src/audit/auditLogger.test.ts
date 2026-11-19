import { describe, expect, it } from 'vitest';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import {
    AuditLogError,
    recordAuditEvent,
    sanitizeAuditInput,
    type AuditQueryClient,
} from './auditLogger';

const USER_UUID = '11111111-1111-4111-8111-111111111111';
const ORG_UUID = '22222222-2222-4222-8222-222222222222';
const PROJECT_UUID = '33333333-3333-4333-8333-333333333333';

type Principal = Pick<AgentPrincipal, 'userUuid' | 'organizationUuid'>;

const principal: Principal = {
    userUuid: USER_UUID,
    organizationUuid: ORG_UUID,
};

interface CapturedCall {
    text: string;
    params?: unknown[];
}

const fakeClient = () => {
    const calls: CapturedCall[] = [];
    const client: AuditQueryClient = {
        query: (text: string, params?: unknown[]) => {
            calls.push({ params, text });
            return Promise.resolve({ rowCount: 1 });
        },
    };
    return { calls, client };
};

const paramsJson = (calls: CapturedCall[]): string =>
    JSON.stringify(calls.map((call) => call.params));

describe('recordAuditEvent', () => {
    it('writes one row for an allowed capability with full context', async () => {
        const { calls, client } = fakeClient();
        await recordAuditEvent(client, {
            capability: 'metric_query',
            input: { explore: 'orders', limit: 10 },
            latencyMs: 12.5,
            policyVerdict: { allowed: true },
            principal,
            projectUuid: PROJECT_UUID,
            rowCount: 10,
            tool: 'run_metric_query',
            verdict: 'allow',
        });
        expect(calls).toHaveLength(1);
        const [call] = calls;
        expect(call?.text).toContain('INSERT INTO');
        expect(call?.text).toContain('audit_logs');
        const params = call?.params ?? [];
        expect(params[0]).toBe(USER_UUID);
        expect(params[1]).toBe('agent.metric_query.allow');
        expect(params[2]).toBe('run_metric_query');
        expect(params[3]).toBe(PROJECT_UUID);
        const metadata = JSON.parse(params[4] as string) as Record<
            string,
            unknown
        >;
        expect(metadata['organizationUuid']).toBe(ORG_UUID);
        expect(metadata['capability']).toBe('metric_query');
        expect(metadata['tool']).toBe('run_metric_query');
        expect(metadata['verdict']).toBe('allow');
        expect(metadata['rowCount']).toBe(10);
        expect(metadata['latencyMs']).toBe(12.5);
        expect(metadata['input']).toEqual({ explore: 'orders', limit: 10 });
    });

    it('writes one row for a denied capability with the deny reason', async () => {
        const { calls, client } = fakeClient();
        await recordAuditEvent(client, {
            capability: 'raw_sql',
            policyVerdict: {
                allowed: false,
                reason: 'INSUFFICIENT_PERMISSIONS',
            },
            principal,
            projectUuid: PROJECT_UUID,
            tool: 'run_raw_sql',
            verdict: 'deny',
        });
        expect(calls).toHaveLength(1);
        const params = calls[0]?.params ?? [];
        expect(params[1]).toBe('agent.raw_sql.deny');
        const metadata = JSON.parse(params[4] as string) as Record<
            string,
            unknown
        >;
        expect(metadata['verdict']).toBe('deny');
        expect(metadata['policyReason']).toBe('INSUFFICIENT_PERMISSIONS');
        expect(metadata['reason']).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('records guard deny reasons without executing anything', async () => {
        const { calls, client } = fakeClient();
        await recordAuditEvent(client, {
            capability: 'raw_sql',
            guardVerdict: {
                allowed: false,
                reason: 'FORBIDDEN_KEYWORD',
            },
            input: 'DROP TABLE orders',
            policyVerdict: { allowed: true },
            principal,
            projectUuid: PROJECT_UUID,
            tool: 'run_raw_sql',
            verdict: 'deny',
        });
        expect(calls).toHaveLength(1);
        const metadata = JSON.parse(
            (calls[0]?.params ?? [])[4] as string,
        ) as Record<string, unknown>;
        expect(metadata['verdict']).toBe('deny');
        expect(metadata['guardReason']).toBe('FORBIDDEN_KEYWORD');
        expect(metadata['reason']).toBe('FORBIDDEN_KEYWORD');
    });

    it('prefers an explicit reason over verdict reasons', async () => {
        const { calls, client } = fakeClient();
        await recordAuditEvent(client, {
            capability: 'export',
            policyVerdict: {
                allowed: false,
                reason: 'RATE_LIMITED',
            },
            principal,
            reason: 'Rate limit retry scheduled',
            tool: 'export_csv',
            verdict: 'deny',
        });
        const metadata = JSON.parse(
            (calls[0]?.params ?? [])[4] as string,
        ) as Record<string, unknown>;
        expect(metadata['reason']).toBe('Rate limit retry scheduled');
        expect(metadata['policyReason']).toBe('RATE_LIMITED');
    });

    it('stores a null project reference when no project applies', async () => {
        const { calls, client } = fakeClient();
        await recordAuditEvent(client, {
            capability: 'discover',
            policyVerdict: { allowed: true },
            principal,
            tool: 'list_projects',
            verdict: 'allow',
        });
        const params = calls[0]?.params ?? [];
        expect(params[3]).toBeNull();
    });

    it('records approval presentation as a boolean, never the token', async () => {
        const { calls, client } = fakeClient();
        await recordAuditEvent(client, {
            approvalPresented: true,
            capability: 'raw_sql',
            guardVerdict: { allowed: true },
            input: 'SELECT 1',
            policyVerdict: { allowed: true },
            principal,
            projectUuid: PROJECT_UUID,
            tool: 'run_raw_sql',
            verdict: 'allow',
        });
        const metadata = JSON.parse(
            (calls[0]?.params ?? [])[4] as string,
        ) as Record<string, unknown>;
        expect(metadata['approvalPresented']).toBe(true);
        expect(paramsJson(calls)).not.toContain('tok-');
    });

    it('never persists credentials or raw secrets', async () => {
        const { calls, client } = fakeClient();
        await recordAuditEvent(client, {
            capability: 'metric_query',
            input: {
                apiKey: 'sk-live-super-secret-value',
                explore: 'orders',
                headers: {
                    Authorization: 'Bearer header-secret-value',
                    password: 'hunter2-secret',
                },
                nested: [{ client_secret: 'nested-client-secret' }],
                pat: 'ldpat_abcdef1234567890secret',
                serviceAccount: 'ldsvc_abcdef1234567890secret',
                token: 'tok-道具-should-stay-hidden',
            },
            policyVerdict: { allowed: true },
            principal,
            tool: 'run_metric_query',
            verdict: 'allow',
        });
        expect(calls).toHaveLength(1);
        const blob = paramsJson(calls);
        expect(blob).not.toContain('sk-live-super-secret-value');
        expect(blob).not.toContain('header-secret-value');
        expect(blob).not.toContain('hunter2-secret');
        expect(blob).not.toContain('nested-client-secret');
        expect(blob).not.toContain('ldpat_abcdef1234567890secret');
        expect(blob).not.toContain('ldsvc_abcdef1234567890secret');
        expect(blob).not.toContain('tok-道具-should-stay-hidden');
        expect(blob).toContain('[REDACTED]');
    });

    it('rejects invalid attribution without touching the database', async () => {
        const { calls, client } = fakeClient();
        await expect(
            recordAuditEvent(client, {
                capability: 'discover',
                principal: { organizationUuid: ORG_UUID, userUuid: '' },
                tool: 'list_projects',
                verdict: 'allow',
            }),
        ).rejects.toBeInstanceOf(AuditLogError);
        await expect(
            recordAuditEvent(client, {
                capability: 'discover',
                principal: {
                    organizationUuid: ORG_UUID,
                    userUuid: 'not-a-uuid',
                },
                tool: 'list_projects',
                verdict: 'allow',
            }),
        ).rejects.toBeInstanceOf(AuditLogError);
        await expect(
            recordAuditEvent(client, {
                capability: 'discover',
                principal,
                projectUuid: 'not-a-uuid',
                tool: 'list_projects',
                verdict: 'allow',
            }),
        ).rejects.toBeInstanceOf(AuditLogError);
        await expect(
            recordAuditEvent(client, {
                capability: '',
                principal,
                tool: 'list_projects',
                verdict: 'allow',
            }),
        ).rejects.toBeInstanceOf(AuditLogError);
        await expect(
            recordAuditEvent(client, {
                capability: 'discover',
                principal,
                rowCount: -1,
                tool: 'list_projects',
                verdict: 'allow',
            }),
        ).rejects.toBeInstanceOf(AuditLogError);
        expect(calls).toHaveLength(0);
    });

    it('keeps error messages free of product names', async () => {
        const { client } = fakeClient();
        const failure: unknown = await recordAuditEvent(client, {
            capability: 'discover',
            principal: { organizationUuid: ORG_UUID, userUuid: '' },
            tool: 'list_projects',
            verdict: 'allow',
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AuditLogError);
        expect((failure as AuditLogError).message).not.toContain('Lightdash');
    });

    it('propagates storage failures instead of swallowing them', async () => {
        const failing: AuditQueryClient = {
            query: () => Promise.reject(new Error('connection refused')),
        };
        await expect(
            recordAuditEvent(failing, {
                capability: 'discover',
                policyVerdict: { allowed: true },
                principal,
                tool: 'list_projects',
                verdict: 'allow',
            }),
        ).rejects.toThrow('connection refused');
    });

    it('handles circular input without crashing', async () => {
        const { calls, client } = fakeClient();
        const loop: Record<string, unknown> = { explore: 'orders' };
        loop['self'] = loop;
        await recordAuditEvent(client, {
            capability: 'discover',
            input: loop,
            policyVerdict: { allowed: true },
            principal,
            tool: 'list_projects',
            verdict: 'allow',
        });
        expect(calls).toHaveLength(1);
    });
});

describe('sanitizeAuditInput', () => {
    it('redacts secret fields at any depth and keeps safe values', () => {
        expect(
            sanitizeAuditInput({
                limit: 5,
                password: 'hunter2-secret',
                where: { token: 'abc-secret' },
            }),
        ).toEqual({
            limit: 5,
            password: '[REDACTED]',
            where: { token: '[REDACTED]' },
        });
    });

    it('redacts token-shaped strings even under innocent keys', () => {
        expect(sanitizeAuditInput({ note: 'ldpat_abcdef1234567890' })).toEqual({
            note: '[REDACTED]',
        });
        expect(sanitizeAuditInput('plain text')).toBe('plain text');
    });

    it('returns null for undefined input', () => {
        expect(sanitizeAuditInput(undefined)).toBeNull();
    });
});
