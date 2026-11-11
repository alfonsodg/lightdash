import {
    buildForwardStatements,
    buildRollbackStatements,
} from './migrationSql';
import { AGENT_EXT_SCHEMA } from './schema';

// Minimal client surface so the runner works with any driver without adding
// a dependency to this package.
export interface MigrationClient {
    query(text: string): Promise<unknown>;
}

export async function migrateUp(
    client: MigrationClient,
    schema: string = AGENT_EXT_SCHEMA,
): Promise<void> {
    for (const statement of buildForwardStatements(schema)) {
        // Sequential: migration statements must apply in order.
        // eslint-disable-next-line no-await-in-loop
        await client.query(statement);
    }
}

export async function migrateDown(
    client: MigrationClient,
    schema: string = AGENT_EXT_SCHEMA,
): Promise<void> {
    for (const statement of buildRollbackStatements(schema)) {
        // Sequential: rollback drops must apply in reverse dependency order.
        // eslint-disable-next-line no-await-in-loop
        await client.query(statement);
    }
}
