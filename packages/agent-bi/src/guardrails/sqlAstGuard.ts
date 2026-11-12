// SQL guardrail for raw agent SQL (Slice C).
//
// Fail-closed by design: the statement must be a single read-only
// SELECT (or WITH ... SELECT). Anything else — DDL, DML, writable CTEs,
// session/transaction control, dialect-specific admin statements,
// dangerous functions, stacked statements — is denied BEFORE any
// warehouse query executes. No SQL parser dependency: the guard works
// from a comment/string-aware scan, so unknown or unparseable syntax
// denies instead of slipping through a dialect gap.
//
// Workspace parser inventory (Phase 2 recon): the only vetted SQL AST
// library in the repo is pgsql-ast-parser 12.0.2, a backend dependency
// used solely by the EE postgresWire path. It covers Postgres only, so
// it cannot rule on Trino or ClickHouse control statements; adding it
// here would also widen this package for one dialect. The guard below
// stays dependency-free and applies the strictest rule of every
// supported dialect instead.
import type { AgentPrincipal } from '../auth/agentPrincipal';

export const DEFAULT_SQL_GUARD_MAX_ROWS = 1000;

export const ABSOLUTE_SQL_GUARD_MAX_ROWS = 10000;

// Dialects the guard has explicit rules for. Any other non-empty
// dialect denies: the caller must confirm coverage before executing.
const SUPPORTED_DIALECTS: readonly string[] = [
    'postgres',
    'redshift',
    'bigquery',
    'snowflake',
    'trino',
    'databricks',
    'clickhouse',
    'duckdb',
    'mysql',
    'mssql',
    'sqlite',
];

// Bare keywords that never appear in a read-only SELECT. Checked as
// whole words outside strings/quotes/comments, so SELECT 'drop' stays
// allowed while DROP TABLE denies. Covers DDL, DML, writable-CTE
// bodies, session/transaction control, and warehouse admin statements.
const FORBIDDEN_KEYWORDS: readonly string[] = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'UPSERT',
    'TRUNCATE',
    'DROP',
    'ALTER',
    'CREATE',
    'GRANT',
    'REVOKE',
    'DENY',
    'COPY',
    'CALL',
    'EXEC',
    'EXECUTE',
    'PREPARE',
    'DEALLOCATE',
    'SET',
    'RESET',
    'DISCARD',
    'USE',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'TRANSACTION',
    'SAVEPOINT',
    'DECLARE',
    'VACUUM',
    'ANALYZE',
    'COMMENT',
    'INTO',
    'SYSTEM',
    'KILL',
    'OPTIMIZE',
    'DETACH',
    'ATTACH',
    'RENAME',
    'EXCHANGE',
    'CHECKPOINT',
    'REINDEX',
    'REFRESH',
    'LISTEN',
    'NOTIFY',
    'UNLISTEN',
    'LOAD',
    'UNLOAD',
    'IMPORT',
    'EXPORT',
    'INSTALL',
    'UNINSTALL',
    'PRAGMA',
    'BACKUP',
    'RESTORE',
    'DBCC',
    'FLUSH',
    'PURGE',
    'SHUTDOWN',
    'RESTART',
    'UNLOCK',
    'WATCH',
    'OPENROWSET',
    'OPENDATASOURCE',
    'OPENQUERY',
];

// REPLACE is both a string function (SELECT replace(...), allowed) and
// a write statement (REPLACE INTO, denied). Every call form is stripped
// before the keyword scan, so only the statement form can deny.
const REPLACE_CALL_PATTERN = /\bREPLACE\s*\(/gi;

// Locking reads take row locks, so FOR UPDATE / FOR SHARE and explicit
// LOCK TABLE deny even though they ride on a SELECT.
const FOR_UPDATE_PATTERN = /\bFOR\b\s+\bUPDATE\b/i;
const FOR_SHARE_PATTERN = /\bFOR\b\s+\bSHARE\b/i;
const LOCK_TABLE_PATTERN = /\bLOCK\s+TABLES?\b/i;

// Functions that sleep, run server commands, read server files, open
// dblinks, or otherwise escape a read-only sandbox. Matched as
// name-plus-open-paren so a column called sleep stays allowed.
const FORBIDDEN_FUNCTIONS: readonly string[] = [
    'SLEEP',
    'BENCHMARK',
    'PG_SLEEP',
    'PG_TERMINATE_BACKEND',
    'PG_CANCEL_BACKEND',
    'PG_RELOAD_CONF',
    'PG_READ_FILE',
    'PG_READ_BINARY_FILE',
    'PG_LS_DIR',
    'PG_STAT_FILE',
    'LO_IMPORT',
    'LO_EXPORT',
    'SET_CONFIG',
    'DBLINK',
    'DBLINK_EXEC',
    'LOAD_FILE',
    'XP_CMDSHELL',
    'SP_EXECUTESQL',
];

const WORD_PATTERN = /[A-Za-z_][A-Za-z0-9_$]*/g;

export type SqlGuardDenyReason =
    | 'EMPTY_SQL'
    | 'MISSING_PRINCIPAL'
    | 'READ_ONLY_UNVERIFIED'
    | 'MISSING_APPROVAL'
    | 'APPROVAL_MISMATCH'
    | 'UNSUPPORTED_DIALECT'
    | 'MULTIPLE_STATEMENTS'
    | 'NOT_READ_ONLY_SELECT'
    | 'FORBIDDEN_KEYWORD'
    | 'FORBIDDEN_FUNCTION'
    | 'INVALID_ROW_LIMIT';

export type SqlGuardVerdict =
    | { allowed: true; sanitizedSql: string; maxRows: number }
    | {
          allowed: false;
          reason: SqlGuardDenyReason;
          message: string;
      };

// Proof from the host that the warehouse session enforcing this query
// is least-privilege read-only. The guard cannot inspect warehouse
// grants itself, so a missing or negative attestation denies.
export interface SqlGuardReadOnlyAttestation {
    enforced: boolean;
}

export interface SqlGuardOptions {
    principal?: Pick<AgentPrincipal, 'userUuid' | 'organizationUuid'> | null;
    readOnly?: SqlGuardReadOnlyAttestation | null;
    approvalToken?: string | null;
    expectedApprovalToken?: string | null;
    maxRows?: number;
    dialect?: string | null;
}

const deny = (
    reason: SqlGuardDenyReason,
    message: string,
): SqlGuardVerdict => ({ allowed: false, reason, message });

// AGENT_RAW_SQL_REQUIRE_APPROVAL can only strengthen the approval gate:
// human approval is always required, and with the flag set to 'true'
// the token must additionally be bound to the exact SQL execution via
// expectedApprovalToken. No value of this flag ever waives approval.
const isStrictApprovalEnv = (): boolean =>
    typeof process !== 'undefined' &&
    process.env?.['AGENT_RAW_SQL_REQUIRE_APPROVAL'] === 'true';

const scanQuoted = (sql: string, start: number, quote: string): number => {
    let index = start + 1;
    while (index < sql.length) {
        if (sql[index] === quote) {
            if (sql[index + 1] === quote) {
                index += 2;
            } else {
                return index + 1;
            }
        } else {
            index += 1;
        }
    }
    return sql.length;
};

const scanBlockComment = (sql: string, start: number): number => {
    let index = start + 2;
    let depth = 1;
    while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
            depth += 1;
            index += 2;
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
            depth -= 1;
            index += 2;
        } else {
            index += 1;
        }
    }
    return index;
};

const DOLLAR_TAG_PATTERN = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/;

const scanDollarTag = (sql: string, start: number): number | null => {
    const rest = sql.slice(start);
    const match = DOLLAR_TAG_PATTERN.exec(rest);
    return match ? start + match[0].length : null;
};

const scanDollarBody = (sql: string, start: number): number => {
    const openTag = sql.slice(0, start);
    const tagMatch = /\$[A-Za-z_][A-Za-z0-9_]*\$$|\$\$$/.exec(openTag);
    const tag = tagMatch ? tagMatch[0] : '$$';
    const close = sql.indexOf(tag, start);
    return close === -1 ? sql.length : close + tag.length;
};

// Render strings, quoted identifiers, and comments as blanks so keyword
// and semicolon scans only see live code. Handles single-quoted
// strings ('' escape), double-quoted/backtick identifiers, nested block
// comments, line comments, and dollar-quoted bodies ($$...$$, $tag$).
const toCodeOnly = (sql: string): string => {
    const out: string[] = [];
    let index = 0;
    const pushBlanks = (count: number): void => {
        out.push(' '.repeat(count));
    };
    while (index < sql.length) {
        const char = sql[index];
        const next = sql[index + 1] ?? '';
        if (char === "'") {
            const end = scanQuoted(sql, index, "'");
            pushBlanks(end - index);
            index = end;
        } else if (char === '"' || char === '`') {
            const end = scanQuoted(sql, index, char);
            pushBlanks(end - index);
            index = end;
        } else if (char === '-' && next === '-') {
            let end = sql.indexOf('\n', index);
            end = end === -1 ? sql.length : end;
            pushBlanks(end - index);
            index = end;
        } else if (char === '/' && next === '*') {
            const end = scanBlockComment(sql, index);
            pushBlanks(end - index);
            index = end;
        } else if (char === '$') {
            const tagEnd = scanDollarTag(sql, index);
            if (tagEnd !== null) {
                const end = scanDollarBody(sql, tagEnd);
                pushBlanks(end - index);
                index = end;
            } else {
                out.push(char ?? '');
                index += 1;
            }
        } else {
            out.push(char ?? '');
            index += 1;
        }
    }
    return out.join('');
};

const firstWordOf = (code: string): string | null => {
    const match = /^\s*([A-Za-z_]+)/.exec(code);
    return match ? (match[1] ?? null) : null;
};

const hasWord = (code: string, word: string): boolean => {
    WORD_PATTERN.lastIndex = 0;
    let match = WORD_PATTERN.exec(code);
    while (match) {
        if (match[0].toUpperCase() === word) {
            return true;
        }
        match = WORD_PATTERN.exec(code);
    }
    return false;
};

const hasFunctionCall = (code: string, name: string): boolean =>
    new RegExp(`\\b${name}\\s*\\(`, 'i').test(code);

export function evaluateSqlGuard(
    sql: unknown,
    options: SqlGuardOptions = {},
): SqlGuardVerdict {
    if (typeof sql !== 'string' || sql.trim().length === 0) {
        return deny('EMPTY_SQL', 'A SQL statement is required.');
    }
    if (
        !options.principal ||
        typeof options.principal.userUuid !== 'string' ||
        options.principal.userUuid.trim().length === 0 ||
        typeof options.principal.organizationUuid !== 'string' ||
        options.principal.organizationUuid.trim().length === 0
    ) {
        return deny(
            'MISSING_PRINCIPAL',
            'A resolved user and organization scope is required before SQL review.',
        );
    }
    if (!options.readOnly || options.readOnly.enforced !== true) {
        return deny(
            'READ_ONLY_UNVERIFIED',
            'Execution needs verified read-only warehouse enforcement.',
        );
    }
    const maxRows =
        options.maxRows === undefined
            ? DEFAULT_SQL_GUARD_MAX_ROWS
            : options.maxRows;
    if (
        typeof maxRows !== 'number' ||
        !Number.isInteger(maxRows) ||
        maxRows < 1 ||
        maxRows > ABSOLUTE_SQL_GUARD_MAX_ROWS
    ) {
        return deny(
            'INVALID_ROW_LIMIT',
            `Row limit must be an integer between 1 and ${ABSOLUTE_SQL_GUARD_MAX_ROWS}.`,
        );
    }
    const dialect = (options.dialect ?? '').trim().toLowerCase();
    if (dialect.length > 0 && !SUPPORTED_DIALECTS.includes(dialect)) {
        return deny(
            'UNSUPPORTED_DIALECT',
            'This warehouse dialect is not covered by the SQL guard.',
        );
    }
    if (
        typeof options.approvalToken !== 'string' ||
        options.approvalToken.length === 0
    ) {
        return deny(
            'MISSING_APPROVAL',
            'Human approval for this exact execution is required.',
        );
    }
    if (
        (options.expectedApprovalToken !== undefined &&
            options.expectedApprovalToken !== null &&
            options.approvalToken !== options.expectedApprovalToken) ||
        (isStrictApprovalEnv() &&
            (options.expectedApprovalToken === undefined ||
                options.expectedApprovalToken === null ||
                options.expectedApprovalToken.length === 0))
    ) {
        return deny(
            'APPROVAL_MISMATCH',
            'Approval is not bound to this exact execution.',
        );
    }

    const code = toCodeOnly(sql);
    const firstSemicolon = code.indexOf(';');
    if (
        firstSemicolon !== -1 &&
        code.slice(firstSemicolon + 1).trim().length > 0
    ) {
        return deny(
            'MULTIPLE_STATEMENTS',
            'Only a single SQL statement is allowed.',
        );
    }
    const first = firstWordOf(code)?.toUpperCase() ?? '';
    if (first !== 'SELECT' && first !== 'WITH') {
        return deny(
            'NOT_READ_ONLY_SELECT',
            'Only read-only SELECT statements are allowed.',
        );
    }
    if (first === 'WITH' && !hasWord(code, 'SELECT')) {
        return deny(
            'NOT_READ_ONLY_SELECT',
            'Only read-only SELECT statements are allowed.',
        );
    }
    if (
        FOR_UPDATE_PATTERN.test(code) ||
        FOR_SHARE_PATTERN.test(code) ||
        LOCK_TABLE_PATTERN.test(code)
    ) {
        return deny('FORBIDDEN_KEYWORD', 'Locking reads are not allowed.');
    }
    const withoutReplaceCalls = code.replace(REPLACE_CALL_PATTERN, ' ');
    for (const keyword of FORBIDDEN_KEYWORDS) {
        if (hasWord(withoutReplaceCalls, keyword)) {
            return deny(
                'FORBIDDEN_KEYWORD',
                'This statement uses a keyword the read-only guard rejects.',
            );
        }
    }
    for (const name of FORBIDDEN_FUNCTIONS) {
        if (hasFunctionCall(code, name)) {
            return deny(
                'FORBIDDEN_FUNCTION',
                'This statement calls a function the read-only guard rejects.',
            );
        }
    }

    const inner = sql.trim().replace(/;\s*$/, '');
    const sanitizedSql = `SELECT * FROM (\n${inner}\n) AS agent_bi_read_only LIMIT ${maxRows}`;
    return { allowed: true, sanitizedSql, maxRows };
}
