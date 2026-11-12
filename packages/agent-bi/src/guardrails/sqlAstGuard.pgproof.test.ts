// PG-backed proof for the SQL guard (Slice C).
//
// Runs ONLY when AGENT_BI_TEST_DATABASE_URL is set (Sandbox/CI); the
// suite skips otherwise so workstation runs never need a database.
// Proves on a real warehouse that allowed verdicts execute within the
// injected row bound and that denied verdicts gate execution.
import { describe, expect, it } from 'vitest';
import { evaluateSqlGuard } from './sqlAstGuard';

const DATABASE_URL = process.env['AGENT_BI_TEST_DATABASE_URL'] ?? '';
const hasDatabase = DATABASE_URL.length > 0;

const optionsWithApproval = (sql: string, maxRows = 5) => ({
    principal: { userUuid: 'user-uuid-1', organizationUuid: 'org-uuid-1' },
    readOnly: { enforced: true },
    approvalToken: `approval-for:${sql}`,
    expectedApprovalToken: `approval-for:${sql}`,
    maxRows,
});

describe.skipIf(!hasDatabase)('sqlAstGuard PG proof', () => {
    it('executes allowed SELECTs on PG within the injected row bound', async () => {
        const { Client } = await import('pg');
        const client = new Client({ connectionString: DATABASE_URL });
        await client.connect();
        try {
            const sql = 'SELECT generate_series(1, 50) AS n';
            const verdict = evaluateSqlGuard(sql, optionsWithApproval(sql, 5));
            expect(verdict.allowed).toBe(true);
            if (!verdict.allowed) {
                return;
            }
            const result = await client.query(verdict.sanitizedSql);
            expect(result.rows).toHaveLength(5);
        } finally {
            await client.end();
        }
    });

    it('denies writes and stacked statements before any warehouse query', async () => {
        const denied = [
            'DROP TABLE proof_should_not_exist',
            'INSERT INTO proof_t SELECT 1',
            'SELECT 1; SELECT 2',
        ];
        for (const sql of denied) {
            const verdict = evaluateSqlGuard(sql, {
                principal: {
                    userUuid: 'user-uuid-1',
                    organizationUuid: 'org-uuid-1',
                },
                readOnly: { enforced: true },
                approvalToken: `approval-for:${sql}`,
                expectedApprovalToken: `approval-for:${sql}`,
                maxRows: 5,
            });
            expect(verdict.allowed).toBe(false);
        }
    });
});
