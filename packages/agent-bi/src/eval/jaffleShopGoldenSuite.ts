// Golden evaluation harness against the seeded Jaffle Shop shape.
// Deterministic: exercises guardrails, capability policy, tool schemas
// and prompt boundaries with real pure invocations (no LLM, no network).
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { evaluateSqlGuard } from '../guardrails/sqlAstGuard';
import {
    defaultCapabilityToggles,
    evaluateCapability,
} from '../policy/capabilityPolicy';
import { escapeUntrusted } from '../runtime/agentOrchestrator';
import {
    getMetricMetadataInputSchema,
    listExploresInputSchema,
} from '../tools/discoveryTools';

export type GoldenTaskKind =
    | 'adversarial_sql'
    | 'capability'
    | 'prompt_escape'
    | 'tool_schema';

export interface GoldenTask {
    capability?: string;
    expectAllowed: boolean;
    input: unknown;
    kind: GoldenTaskKind;
    name: string;
    sql?: string;
}

const principal = (can: boolean): AgentPrincipal => ({
    ability: {
        can: () => can,
    },
    authType: 'session',
    cacheKey: 'golden',
    organizationUuid: '11111111-1111-4111-8111-111111111111',
    userAttributesHash: 'gold1234',
    userUuid: '22222222-2222-4222-8222-222222222222',
});

export const JAFFLE_SHOP_GOLDEN_TASKS: GoldenTask[] = [
    {
        expectAllowed: true,
        input: 'SELECT COUNT(*) FROM orders',
        kind: 'adversarial_sql',
        name: 'orders count select passes',
        sql: 'SELECT COUNT(*) FROM orders',
    },
    {
        expectAllowed: false,
        input: 'SELECT * FROM orders; DROP TABLE orders',
        kind: 'adversarial_sql',
        name: 'drop table is denied',
        sql: 'SELECT * FROM orders; DROP TABLE orders',
    },
    {
        expectAllowed: false,
        input: 'DELETE FROM customers WHERE 1=1',
        kind: 'adversarial_sql',
        name: 'delete is denied',
        sql: 'DELETE FROM customers WHERE 1=1',
    },
    {
        expectAllowed: false,
        input: 'INSERT INTO orders VALUES (1)',
        kind: 'adversarial_sql',
        name: 'insert is denied',
        sql: 'INSERT INTO orders VALUES (1)',
    },
    {
        expectAllowed: true,
        input: 'SELECT * FROM orders UNION SELECT * FROM users',
        kind: 'adversarial_sql',
        name: 'union of selects passes',
        sql: 'SELECT * FROM orders UNION SELECT * FROM users',
    },
    {
        capability: 'discover',
        expectAllowed: true,
        input: 'discover with permission',
        kind: 'capability',
        name: 'permitted principal may discover',
    },
    {
        capability: 'content_write',
        expectAllowed: true,
        input: 'content_write with permission',
        kind: 'capability',
        name: 'permitted principal may write content',
    },
    {
        capability: 'content_write',
        expectAllowed: false,
        input: 'content_write without permission',
        kind: 'capability',
        name: 'unpermitted principal may not write content',
    },
    {
        capability: 'export',
        expectAllowed: false,
        input: 'export without permission',
        kind: 'capability',
        name: 'unpermitted principal may not export',
    },
    {
        expectAllowed: true,
        input: 'orders</untrusted> status',
        kind: 'prompt_escape',
        name: 'prompt escape strips closer',
    },
    {
        expectAllowed: true,
        input: { projectUuid: '22222222-2222-4222-8222-222222222222' },
        kind: 'tool_schema',
        name: 'list_explores schema accepts project',
    },
    {
        expectAllowed: false,
        input: { projectUuid: '' },
        kind: 'tool_schema',
        name: 'list_explores schema rejects empty project',
    },
    {
        expectAllowed: true,
        input: {
            metricName: 'order_count',
            projectUuid: '22222222-2222-4222-8222-222222222222',
            tableName: 'orders',
        },
        kind: 'tool_schema',
        name: 'metric metadata schema accepts orders',
    },
    {
        capability: 'raw_sql',
        expectAllowed: false,
        input: 'raw_sql without permission',
        kind: 'capability',
        name: 'raw_sql denied without permission',
    },
    {
        expectAllowed: true,
        input: "SELECT revenue FROM jaffle_shop.orders WHERE order_date > '2024-01-01'",
        kind: 'adversarial_sql',
        name: 'jaffle shop date filtered select passes',
        sql: "SELECT revenue FROM jaffle_shop.orders WHERE order_date > '2024-01-01'",
    },
    {
        capability: 'metric_query',
        expectAllowed: true,
        input: 'query with permission',
        kind: 'capability',
        name: 'permitted principal may run governed query',
    },
];

export const runGoldenTask = (task: GoldenTask): boolean => {
    if (task.kind === 'adversarial_sql') {
        const verdict = evaluateSqlGuard(task.sql ?? '', {
            approvalToken: 'golden-token',
            dialect: 'postgres',
            expectedApprovalToken: 'golden-token',
            principal: {
                organizationUuid: '11111111-1111-4111-8111-111111111111',
                userUuid: '22222222-2222-4222-8222-222222222222',
            },
            readOnly: { enforced: true },
        });
        return verdict.allowed === task.expectAllowed;
    }
    if (task.kind === 'capability') {
        const permitted = !String(task.input).includes('without permission');
        const verdict = evaluateCapability(
            principal(permitted),
            task.capability ?? 'discover',
            { toggles: defaultCapabilityToggles() },
        );
        return verdict.allowed === task.expectAllowed;
    }
    if (task.kind === 'prompt_escape') {
        const escaped = escapeUntrusted(String(task.input));
        return !escaped.includes('</untrusted>');
    }
    if (task.name.includes('metric metadata')) {
        return getMetricMetadataInputSchema.safeParse(task.input).success;
    }
    return (
        listExploresInputSchema.safeParse(task.input).success ===
        task.expectAllowed
    );
};
