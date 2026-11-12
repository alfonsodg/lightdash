import { afterAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from './migrate';
import { AGENT_EXT_MIGRATION_VERSION } from './schema';

// Real PostgreSQL proof: needs pgvector/pgvector:pg15 and the `pg` driver.
// Run where a database exists:
//   AGENT_BI_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm -F agent-bi test src/db/migrate.integration.test.ts
const connectionString = process.env.AGENT_BI_TEST_DATABASE_URL;
const canRun =
    typeof connectionString === 'string' && connectionString.length > 0;
const suite = canRun ? describe : describe.skip;

type PgClient = {
    query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
    end(): Promise<void>;
};

let client: PgClient | undefined;

async function getClient(): Promise<PgClient> {
    if (client) {
        return client;
    }
    const { Client } = await import('pg');
    const pg = new Client({ connectionString: connectionString ?? '' });
    await pg.connect();
    client = pg;
    return pg;
}

async function tableNames(): Promise<string[]> {
    const db = await getClient();
    const result = await db.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'agent_ext' ORDER BY tablename`,
    );
    return result.rows.map((row) => String(row.tablename));
}

afterAll(async () => {
    await client?.end();
    client = undefined;
});

suite('agent_ext migrations on real PostgreSQL', () => {
    it('creates the schema, tables, and ledger row', async () => {
        const db = await getClient();
        await migrateUp({ query: (text) => db.query(text) });
        expect(await tableNames()).toEqual(
            expect.arrayContaining([
                'audit_logs',
                'catalog_index',
                'messages',
                'migrations',
                'skills',
                'threads',
            ]),
        );
        const ledger = await db.query(
            `SELECT version FROM agent_ext.migrations WHERE version = '${AGENT_EXT_MIGRATION_VERSION}'`,
        );
        expect(ledger.rows).toHaveLength(1);
        const vector = await db.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = 'agent_ext' AND table_name = 'catalog_index' AND column_name IN ('embedding', 'document')`,
        );
        expect(vector.rows).toHaveLength(2);
    });

    it('rolls back to an empty isolated schema', async () => {
        const db = await getClient();
        await migrateDown({ query: (text) => db.query(text) });
        const remaining = (await tableNames()).filter(
            (name) => name !== 'migrations',
        );
        expect(remaining).toEqual([]);
        const ledger = await db.query(
            `SELECT version FROM agent_ext.migrations WHERE version = '${AGENT_EXT_MIGRATION_VERSION}'`,
        );
        expect(ledger.rows).toHaveLength(0);
    });
});
