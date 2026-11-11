export const AGENT_EXT_SCHEMA = 'agent_ext';

export const AGENT_EXT_MIGRATION_VERSION = '0001_agent_ext_init';

export const CATALOG_EMBEDDING_DIMENSIONS = 1536;

export const AGENT_EXT_TABLES = {
    threads: 'threads',
    messages: 'messages',
    skills: 'skills',
    auditLogs: 'audit_logs',
    catalogIndex: 'catalog_index',
    migrations: 'migrations',
} as const;

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/;

export function resolveSchemaName(schema?: string): string {
    const name = (schema ?? AGENT_EXT_SCHEMA).trim();
    if (!SCHEMA_PATTERN.test(name)) {
        throw new Error('Invalid agent extension schema name');
    }
    return name;
}
