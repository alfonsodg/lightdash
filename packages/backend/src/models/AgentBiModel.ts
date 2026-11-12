import { type Knex } from 'knex';

// Scoped accessor for the agent_ext schema owned by @lightdash/agent-bi.
// SQL text comes from that package; this model only supplies connectivity.
export class AgentBiModel {
    private readonly database: Knex;

    constructor({ database }: { database: Knex }) {
        this.database = database;
    }

    async query(
        text: string,
        params?: unknown[],
    ): Promise<{ rows: Array<Record<string, unknown>> }> {
        const result = (await this.database.raw(
            text,
            params ?? [],
        )) as unknown as {
            rows?: Array<Record<string, unknown>>;
        };
        return { rows: result.rows ?? [] };
    }
}
