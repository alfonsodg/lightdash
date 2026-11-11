import { describe, expect, it } from 'vitest';
import {
    buildForwardStatements,
    buildRollbackStatements,
} from './migrationSql';

const joined = (statements: string[]): string => statements.join('\n');

describe('buildForwardStatements', () => {
    it('creates the isolated schema idempotently', () => {
        const sql = joined(buildForwardStatements());
        expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "agent_ext"');
    });

    it('enables uuid and vector extensions idempotently', () => {
        const sql = joined(buildForwardStatements());
        expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
        expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "vector"');
    });

    it('creates every table with a primary key', () => {
        const sql = joined(buildForwardStatements());
        for (const table of [
            'threads',
            'messages',
            'skills',
            'audit_logs',
            'catalog_index',
            'migrations',
        ]) {
            expect(sql).toContain(
                `CREATE TABLE IF NOT EXISTS "agent_ext"."${table}"`,
            );
        }
        expect(sql.match(/PRIMARY KEY/g)?.length).toBeGreaterThanOrEqual(6);
    });

    it('gives catalog_index vector and tsvector columns with indexes', () => {
        const sql = joined(buildForwardStatements());
        expect(sql).toContain('embedding vector(1536)');
        expect(sql).toContain('document tsvector');
        expect(sql).toContain('USING hnsw (embedding vector_cosine_ops)');
        expect(sql).toContain('USING gin (document)');
    });

    it('links messages to threads with a cascade and an index', () => {
        const sql = joined(buildForwardStatements());
        expect(sql).toContain(
            'REFERENCES "agent_ext"."threads" (thread_uuid) ON DELETE CASCADE',
        );
        expect(sql).toContain(
            'messages_thread_uuid_idx ON "agent_ext"."messages" (thread_uuid)',
        );
    });

    it('records the migration in the isolated ledger', () => {
        const sql = joined(buildForwardStatements());
        expect(sql).toContain(
            `INSERT INTO "agent_ext"."migrations" (version) VALUES ('0001_agent_ext_init') ON CONFLICT (version) DO NOTHING`,
        );
    });

    it('never touches shared schemas', () => {
        const sql = joined(buildForwardStatements());
        expect(sql).not.toMatch(/public\./);
        expect(sql).not.toContain('knex_migrations');
    });

    it('sets a bounded lock timeout for blocking DDL', () => {
        expect(buildForwardStatements()[0]).toContain('lock_timeout');
    });

    it('honours a custom schema name everywhere', () => {
        const sql = joined(buildForwardStatements('agent_ext_2'));
        expect(sql).toContain('"agent_ext_2"."threads"');
        expect(sql).not.toContain('"agent_ext"."threads"');
    });
});

describe('buildRollbackStatements', () => {
    it('drops tables in reverse dependency order', () => {
        const statements = buildRollbackStatements();
        const drops = statements.filter((s) => s.startsWith('DROP TABLE'));
        expect(drops).toEqual([
            'DROP TABLE IF EXISTS "agent_ext"."catalog_index"',
            'DROP TABLE IF EXISTS "agent_ext"."audit_logs"',
            'DROP TABLE IF EXISTS "agent_ext"."skills"',
            'DROP TABLE IF EXISTS "agent_ext"."messages"',
            'DROP TABLE IF EXISTS "agent_ext"."threads"',
        ]);
    });

    it('clears the ledger row and keeps the ledger table', () => {
        const sql = joined(buildRollbackStatements());
        expect(sql).toContain(
            `DELETE FROM "agent_ext"."migrations" WHERE version = '0001_agent_ext_init'`,
        );
        expect(sql).not.toContain(
            'DROP TABLE IF EXISTS "agent_ext"."migrations"',
        );
    });

    it('never touches shared schemas', () => {
        const sql = joined(buildRollbackStatements());
        expect(sql).not.toMatch(/public\./);
        expect(sql).not.toContain('knex_migrations');
    });
});
