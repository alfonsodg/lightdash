import { describe, expect, it, vi } from 'vitest';
import { migrateDown, migrateUp, type MigrationClient } from './migrate';
import {
    buildForwardStatements,
    buildRollbackStatements,
} from './migrationSql';

function createRecordingClient(): MigrationClient & { seen: string[] } {
    const seen: string[] = [];
    return {
        seen,
        query: vi.fn(async (text: string) => {
            seen.push(text);
            return undefined;
        }),
    };
}

describe('migrateUp', () => {
    it('executes every forward statement in order', async () => {
        const client = createRecordingClient();
        await migrateUp(client);
        expect(client.seen).toEqual(buildForwardStatements());
        expect(client.seen.length).toBeGreaterThan(10);
    });
});

describe('migrateDown', () => {
    it('executes every rollback statement in order', async () => {
        const client = createRecordingClient();
        await migrateDown(client);
        expect(client.seen).toEqual(buildRollbackStatements());
    });

    it('round-trips up then down without shared-schema access', async () => {
        const client = createRecordingClient();
        await migrateUp(client);
        await migrateDown(client);
        const all = client.seen.join('\n');
        expect(all).not.toMatch(/public\./);
        expect(all).not.toContain('knex_migrations');
    });
});
