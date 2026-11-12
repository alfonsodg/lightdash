import type { Knex } from 'knex';
import { describe, expect, it, vi } from 'vitest';
import { AgentBiModel } from './AgentBiModel';

describe('AgentBiModel', () => {
    it('passes Postgres placeholders and bindings to the connection', async () => {
        const rows = [{ thread_uuid: 'thread-uuid' }];
        const connection = {
            query: vi.fn().mockResolvedValue({ rows }),
        };
        const client = {
            acquireConnection: vi.fn().mockResolvedValue(connection),
            releaseConnection: vi.fn().mockResolvedValue(undefined),
        };
        const model = new AgentBiModel({
            database: { client } as unknown as Knex,
        });

        const result = await model.query(
            'SELECT thread_uuid FROM agent_ext.threads WHERE project_uuid = $1',
            ['project-uuid'],
        );

        expect(connection.query).toHaveBeenCalledWith(
            'SELECT thread_uuid FROM agent_ext.threads WHERE project_uuid = $1',
            ['project-uuid'],
        );
        expect(client.releaseConnection).toHaveBeenCalledWith(connection);
        expect(result).toEqual({ rows });
    });

    it('releases the connection when the query fails', async () => {
        const connection = {
            query: vi.fn().mockRejectedValue(new Error('query failed')),
        };
        const client = {
            acquireConnection: vi.fn().mockResolvedValue(connection),
            releaseConnection: vi.fn().mockResolvedValue(undefined),
        };
        const model = new AgentBiModel({
            database: { client } as unknown as Knex,
        });

        await expect(model.query('SELECT 1')).rejects.toThrow('query failed');
        expect(client.releaseConnection).toHaveBeenCalledWith(connection);
    });
});
