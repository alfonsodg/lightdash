import { describe, expect, it } from 'vitest';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import { evaluateSqlGuard, type SqlGuardOptions } from './sqlAstGuard';

const principal: Pick<AgentPrincipal, 'userUuid' | 'organizationUuid'> = {
    userUuid: 'user-uuid-1',
    organizationUuid: 'org-uuid-1',
};

const baseOptions = (
    overrides: Partial<SqlGuardOptions> = {},
): SqlGuardOptions => ({
    principal,
    readOnly: { enforced: true },
    approvalToken: 'approval-token-1',
    expectedApprovalToken: 'approval-token-1',
    maxRows: 5,
    ...overrides,
});

describe('evaluateSqlGuard allow paths', () => {
    it('allows a plain SELECT and wraps it with a bounded LIMIT', () => {
        const verdict = evaluateSqlGuard(
            'SELECT id FROM orders',
            baseOptions(),
        );
        expect(verdict.allowed).toBe(true);
        if (verdict.allowed) {
            expect(verdict.maxRows).toBe(5);
            expect(verdict.sanitizedSql).toContain('SELECT id FROM orders');
            expect(verdict.sanitizedSql).toContain('LIMIT 5');
        }
    });

    it('defaults maxRows to 1000 when not provided', () => {
        const { maxRows, ...withoutMax } = baseOptions();
        void maxRows;
        const verdict = evaluateSqlGuard('SELECT 1', withoutMax);
        expect(verdict.allowed).toBe(true);
        if (verdict.allowed) {
            expect(verdict.maxRows).toBe(1000);
            expect(verdict.sanitizedSql).toContain('LIMIT 1000');
        }
    });

    it('allows WITH ... SELECT and lowercase keywords', () => {
        const verdict = evaluateSqlGuard(
            'with top_orders as (select id from orders) select id from top_orders',
            baseOptions(),
        );
        expect(verdict.allowed).toBe(true);
    });

    it('allows an explicit supported dialect and an omitted dialect', () => {
        expect(
            evaluateSqlGuard('SELECT 1', baseOptions({ dialect: 'postgres' }))
                .allowed,
        ).toBe(true);
        expect(
            evaluateSqlGuard('SELECT 1', baseOptions({ dialect: null }))
                .allowed,
        ).toBe(true);
    });

    it('ignores semicolons inside string literals and comments', () => {
        const verdict = evaluateSqlGuard(
            "SELECT 'a;b' AS value -- trailing; comment\n/* block; comment */",
            baseOptions(),
        );
        expect(verdict.allowed).toBe(true);
    });

    it('handles escaped quotes and dollar-quoted bodies', () => {
        const verdict = evaluateSqlGuard(
            "SELECT 'it''s ; fine' AS text, $$raw ; text$$ AS raw",
            baseOptions(),
        );
        expect(verdict.allowed).toBe(true);
    });

    it('allows a single trailing semicolon', () => {
        const verdict = evaluateSqlGuard('SELECT 1;', baseOptions());
        expect(verdict.allowed).toBe(true);
        if (verdict.allowed) {
            expect(verdict.sanitizedSql).not.toMatch(/;[\s]*\)/);
        }
    });

    it('allows the REPLACE string function while denying REPLACE INTO', () => {
        expect(
            evaluateSqlGuard(
                "SELECT replace(name, 'a', 'b') FROM customers",
                baseOptions(),
            ).allowed,
        ).toBe(true);
        const denied = evaluateSqlGuard(
            'REPLACE INTO customers SELECT * FROM staging',
            baseOptions(),
        );
        expect(denied.allowed).toBe(false);
    });
});

describe('evaluateSqlGuard fail-closed gates', () => {
    it('denies empty, blank, and non-string SQL', () => {
        for (const sql of ['', '   ', null, undefined, 42]) {
            const verdict = evaluateSqlGuard(sql, baseOptions());
            expect(verdict.allowed).toBe(false);
            if (!verdict.allowed) {
                expect(verdict.reason).toBe('EMPTY_SQL');
            }
        }
    });

    it('denies a missing principal or missing user scope', () => {
        const missing = evaluateSqlGuard('SELECT 1', {
            ...baseOptions(),
            principal: null,
        });
        expect(missing.allowed).toBe(false);
        if (!missing.allowed) {
            expect(missing.reason).toBe('MISSING_PRINCIPAL');
        }
        const scopedOut = evaluateSqlGuard('SELECT 1', {
            ...baseOptions(),
            principal: { userUuid: '', organizationUuid: 'org-uuid-1' },
        });
        expect(scopedOut.allowed).toBe(false);
        if (!scopedOut.allowed) {
            expect(scopedOut.reason).toBe('MISSING_PRINCIPAL');
        }
    });

    it('denies unverifiable read-only warehouse enforcement', () => {
        for (const readOnly of [null, undefined, { enforced: false }]) {
            const verdict = evaluateSqlGuard(
                'SELECT 1',
                baseOptions({ readOnly }),
            );
            expect(verdict.allowed).toBe(false);
            if (!verdict.allowed) {
                expect(verdict.reason).toBe('READ_ONLY_UNVERIFIED');
            }
        }
    });

    it('denies a missing approval token and a token that is not bound to the execution', () => {
        const missing = evaluateSqlGuard(
            'SELECT 1',
            baseOptions({ approvalToken: null }),
        );
        expect(missing.allowed).toBe(false);
        if (!missing.allowed) {
            expect(missing.reason).toBe('MISSING_APPROVAL');
        }
        const mismatched = evaluateSqlGuard(
            'SELECT 1',
            baseOptions({ approvalToken: 'other-token' }),
        );
        expect(mismatched.allowed).toBe(false);
        if (!mismatched.allowed) {
            expect(mismatched.reason).toBe('APPROVAL_MISMATCH');
        }
    });

    it('denies unsupported dialects', () => {
        const verdict = evaluateSqlGuard(
            'SELECT 1',
            baseOptions({ dialect: 'oracle-x' }),
        );
        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('UNSUPPORTED_DIALECT');
        }
    });

    it('denies multiple statements', () => {
        const verdict = evaluateSqlGuard('SELECT 1; SELECT 2', baseOptions());
        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('MULTIPLE_STATEMENTS');
        }
    });

    it('denies non-SELECT statements before keyword checks', () => {
        for (const sql of [
            'DELETE FROM orders',
            'EXPLAIN SELECT 1',
            'SHOW TABLES',
        ]) {
            const verdict = evaluateSqlGuard(sql, baseOptions());
            expect(verdict.allowed).toBe(false);
            if (!verdict.allowed) {
                expect(verdict.reason).toBe('NOT_READ_ONLY_SELECT');
            }
        }
    });

    it('denies DDL, DML, and session statements inside a SELECT', () => {
        const cases: ReadonlyArray<[string, string]> = [
            [
                'SELECT * FROM t WHERE id IN (SELECT id FROM u); DROP TABLE u',
                'multi',
            ],
            [
                'WITH gone AS (DELETE FROM t RETURNING id) SELECT * FROM gone',
                'writable cte',
            ],
            ['SELECT * INTO archive FROM orders', 'into'],
            ['SELECT * FROM orders FOR UPDATE', 'for update'],
            ['SELECT * FROM orders FOR SHARE', 'for share'],
            ['SELECT * FROM t; GRANT SELECT ON t TO analyst', 'grant'],
            ['SELECT * FROM t WHERE true; COPY t TO STDOUT', 'copy'],
            ['SELECT set_config(:k, :v, false)', 'set_config'],
            [
                'SELECT * FROM t UNION SELECT * FROM u; ALTER TABLE u ADD COLUMN x int',
                'alter',
            ],
        ];
        for (const [sql] of cases) {
            const verdict = evaluateSqlGuard(sql, baseOptions({ maxRows: 5 }));
            expect(verdict.allowed).toBe(false);
        }
        const keywordCase = evaluateSqlGuard(
            'WITH gone AS (DELETE FROM t RETURNING id) SELECT * FROM gone',
            baseOptions(),
        );
        expect(keywordCase.allowed).toBe(false);
        if (!keywordCase.allowed) {
            expect(keywordCase.reason).toBe('FORBIDDEN_KEYWORD');
        }
    });

    it('denies ClickHouse control statements', () => {
        for (const sql of [
            'SYSTEM FLUSH LOGS',
            'KILL QUERY WHERE query_id = 1',
            'SELECT * FROM t; OPTIMIZE TABLE t FINAL',
        ]) {
            const verdict = evaluateSqlGuard(sql, baseOptions());
            expect(verdict.allowed).toBe(false);
        }
    });

    it('denies dangerous functions', () => {
        for (const sql of [
            'SELECT pg_sleep(1)',
            'SELECT SLEEP(5)',
            "SELECT load_file('/etc/passwd')",
            'SELECT dblink_exec(:conn, :sql)',
        ]) {
            const verdict = evaluateSqlGuard(sql, baseOptions());
            expect(verdict.allowed).toBe(false);
            if (!verdict.allowed) {
                expect(verdict.reason).toBe('FORBIDDEN_FUNCTION');
            }
        }
    });

    it('denies invalid row limits', () => {
        for (const maxRows of [0, -1, 1.5, Number.NaN, 20000]) {
            const verdict = evaluateSqlGuard(
                'SELECT 1',
                baseOptions({ maxRows }),
            );
            expect(verdict.allowed).toBe(false);
            if (!verdict.allowed) {
                expect(verdict.reason).toBe('INVALID_ROW_LIMIT');
            }
        }
    });

    it('keeps every denial message free of brand strings', () => {
        const samples = [
            evaluateSqlGuard('', baseOptions()),
            evaluateSqlGuard('SELECT 1', {
                ...baseOptions(),
                principal: null,
            }),
            evaluateSqlGuard('SELECT 1', baseOptions({ readOnly: null })),
            evaluateSqlGuard('SELECT 1', baseOptions({ approvalToken: '' })),
            evaluateSqlGuard('SELECT 1; SELECT 2', baseOptions()),
            evaluateSqlGuard('DROP TABLE t', baseOptions()),
            evaluateSqlGuard('SELECT pg_sleep(1)', baseOptions()),
        ];
        for (const verdict of samples) {
            expect(verdict.allowed).toBe(false);
            if (!verdict.allowed) {
                expect(verdict.message).not.toMatch(/lightdash/i);
            }
        }
    });
});
