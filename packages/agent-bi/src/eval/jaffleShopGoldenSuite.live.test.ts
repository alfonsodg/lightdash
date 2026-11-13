import { describe, expect, it } from 'vitest';
import { createLightdashV2Client } from '../client/lightdashV2Client';
import { evaluateSqlGuard } from '../guardrails/sqlAstGuard';

const BASE_URL = (process.env.LIGHTDASH_E2E_BASE_URL ?? '').replace(/\/$/, '');
const EMAIL = process.env.LIGHTDASH_E2E_EMAIL ?? 'demo@lightdash.com';
const PASSWORD = process.env.LIGHTDASH_E2E_PASSWORD ?? 'demo_password!';
const ENV_PROJECT_UUID = process.env.LIGHTDASH_E2E_PROJECT_UUID ?? '';

const extractCookie = (res: Response): string => {
    const raw = res.headers.get('set-cookie');
    if (!raw) return '';
    return raw
        .split(',')
        .map((part) => part.split(';')[0]?.trim() ?? '')
        .filter(Boolean)
        .join('; ');
};

describe.skipIf(!BASE_URL)('Jaffle Shop Live Integrated Golden Suite', () => {
    let cookie = '';
    let projectUuid = ENV_PROJECT_UUID;

    it('authenticates and resolves seeded Jaffle Shop project', async () => {
        const loginRes = await fetch(`${BASE_URL}/api/v1/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
        });
        expect(loginRes.status).toBe(200);
        cookie = extractCookie(loginRes);
        expect(cookie).toContain('connect.sid=');

        if (!projectUuid) {
            const projectsRes = await fetch(`${BASE_URL}/api/v1/org/projects`, {
                headers: { cookie },
            });
            expect(projectsRes.status).toBe(200);
            const payload = (await projectsRes.json()) as {
                results?: Array<{ projectUuid: string; name: string }>;
            };
            const first = payload.results?.[0];
            expect(first?.projectUuid).toBeTruthy();
            projectUuid = first?.projectUuid ?? '';
        }
    });

    it('serves /api/ext/v1/health and /api/ext/v1/preflight for the project', async () => {
        const healthRes = await fetch(`${BASE_URL}/api/ext/v1/health`, {
            headers: { cookie },
        });
        expect(healthRes.status).toBe(200);
        const healthBody = (await healthRes.json()) as {
            results?: { enabled?: boolean };
        };
        expect(healthBody.results?.enabled).toBe(true);

        const preflightRes = await fetch(`${BASE_URL}/api/ext/v1/preflight`, {
            headers: { cookie },
        });
        expect(preflightRes.status).toBe(200);
        const body = (await preflightRes.json()) as {
            results?: {
                principal?: {
                    userUuid?: string;
                    organizationUuid?: string;
                    cacheKey?: string;
                };
                capabilities?: string[];
            };
        };
        expect(body.results?.principal?.userUuid).toBeTruthy();
        expect(body.results?.principal?.organizationUuid).toBeTruthy();
        expect(body.results?.capabilities).toContain('discover');
        expect(body.results?.capabilities).toContain('metric_query');
    });

    it('executes governed v2 metric query on Jaffle Shop orders explore', async () => {
        const client = createLightdashV2Client({
            baseUrl: BASE_URL,
            headers: { cookie },
            timeoutMs: 30_000,
        });

        const page = await client.runMetricQuery(projectUuid, {
            exploreName: 'orders',
            dimensions: ['orders_status'],
            metrics: ['orders_total_order_amount'],
            filters: {},
            sorts: [{ fieldId: 'orders_total_order_amount', descending: true }],
            limit: 10,
            tableCalculations: [],
        });

        expect(page.rows.length).toBeGreaterThan(0);
        const firstRow = page.rows[0] as Record<string, unknown>;
        expect(firstRow).toHaveProperty('orders_status');
        expect(firstRow).toHaveProperty('orders_total_order_amount');
    });

    it('enforces read-only SQL guardrails and executes read-only v2 SQL query', async () => {
        const unsafe = evaluateSqlGuard('DROP TABLE orders', {
            dialect: 'Postgres',
            principal: { userUuid: 'live-eval-user', organizationUuid: 'live-eval-org' },
            readOnly: { enforced: true },
        });
        expect(unsafe.allowed).toBe(false);

        const client = createLightdashV2Client({
            baseUrl: BASE_URL,
            headers: { cookie },
            timeoutMs: 30_000,
        });
        const page = await client.runSqlQuery(projectUuid, {
            sql: 'SELECT 1 AS live_check',
            limit: 5,
        });
        expect(page.rows.length).toBe(1);
    });

    it('creates and lists threads scoped to projectUuid and rejects unauthorized project access', async () => {
        const createRes = await fetch(
            `${BASE_URL}/api/ext/v1/projects/${encodeURIComponent(projectUuid)}/threads`,
            {
                method: 'POST',
                headers: {
                    cookie,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Live Golden Eval Thread',
                }),
            },
        );
        expect([200, 201]).toContain(createRes.status);

        const listRes = await fetch(
            `${BASE_URL}/api/ext/v1/projects/${encodeURIComponent(projectUuid)}/threads`,
            { headers: { cookie } },
        );
        expect(listRes.status).toBe(200);

        const foreignRes = await fetch(
            `${BASE_URL}/api/ext/v1/projects/00000000-0000-0000-0000-000000000000/threads`,
            { headers: { cookie } },
        );
        expect([403, 404]).toContain(foreignRes.status);
    });
});
