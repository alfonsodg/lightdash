import { describe, expect, it } from 'vitest';
import {
    AGENT_EXT_MIGRATION_VERSION,
    AGENT_EXT_SCHEMA,
    AGENT_EXT_TABLES,
    resolveSchemaName,
} from './schema';

describe('resolveSchemaName', () => {
    it('defaults to the isolated schema', () => {
        expect(resolveSchemaName()).toBe(AGENT_EXT_SCHEMA);
        expect(resolveSchemaName(undefined)).toBe('agent_ext');
    });

    it('accepts safe custom schema names', () => {
        expect(resolveSchemaName('agent_ext')).toBe('agent_ext');
        expect(resolveSchemaName('agent_ext_2')).toBe('agent_ext_2');
    });

    it('rejects unsafe names without echoing them', () => {
        expect(() => resolveSchemaName('public; DROP TABLE x')).toThrow(
            'Invalid agent extension schema name',
        );
        expect(() => resolveSchemaName('Agent-Ext')).toThrow(
            'Invalid agent extension schema name',
        );
    });

    it('pins the expected table set', () => {
        expect(Object.values(AGENT_EXT_TABLES).sort()).toEqual(
            [
                'audit_logs',
                'catalog_index',
                'messages',
                'migrations',
                'skills',
                'threads',
            ].sort(),
        );
        expect(AGENT_EXT_MIGRATION_VERSION).toBe('0001_agent_ext_init');
    });
});
