import {
    AGENT_EXT_MIGRATION_VERSION,
    AGENT_EXT_TABLES,
    CATALOG_EMBEDDING_DIMENSIONS,
    resolveSchemaName,
} from './schema';

// Forward + rollback SQL for the isolated extension schema. Every statement
// is idempotent so a partial run can be safely retried.
export function buildForwardStatements(schema?: string): string[] {
    const s = resolveSchemaName(schema);
    return [
        `SET LOCAL lock_timeout = '60s'`,
        `CREATE SCHEMA IF NOT EXISTS "${s}"`,
        `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`,
        `CREATE EXTENSION IF NOT EXISTS "vector"`,
        `CREATE TABLE IF NOT EXISTS "${s}"."${AGENT_EXT_TABLES.migrations}" (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
)`,
        `CREATE TABLE IF NOT EXISTS "${s}"."${AGENT_EXT_TABLES.threads}" (
    thread_uuid uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_uuid uuid NOT NULL,
    created_by uuid,
    title text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
)`,
        `CREATE INDEX IF NOT EXISTS threads_organization_uuid_idx ON "${s}"."${AGENT_EXT_TABLES.threads}" (organization_uuid)`,
        `CREATE TABLE IF NOT EXISTS "${s}"."${AGENT_EXT_TABLES.messages}" (
    message_uuid uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    thread_uuid uuid NOT NULL REFERENCES "${s}"."${AGENT_EXT_TABLES.threads}" (thread_uuid) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
)`,
        `CREATE INDEX IF NOT EXISTS messages_thread_uuid_idx ON "${s}"."${AGENT_EXT_TABLES.messages}" (thread_uuid)`,
        `CREATE TABLE IF NOT EXISTS "${s}"."${AGENT_EXT_TABLES.skills}" (
    skill_uuid uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug text NOT NULL UNIQUE,
    version text NOT NULL DEFAULT '1',
    manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
)`,
        `CREATE TABLE IF NOT EXISTS "${s}"."${AGENT_EXT_TABLES.auditLogs}" (
    audit_log_id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    actor_uuid uuid,
    action text NOT NULL,
    entity_type text NOT NULL DEFAULT '',
    entity_uuid uuid,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
)`,
        `CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON "${s}"."${AGENT_EXT_TABLES.auditLogs}" (entity_type, entity_uuid)`,
        `CREATE TABLE IF NOT EXISTS "${s}"."${AGENT_EXT_TABLES.catalogIndex}" (
    catalog_uuid uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_uuid uuid NOT NULL,
    resource_type text NOT NULL,
    resource_uuid uuid NOT NULL,
    content text NOT NULL DEFAULT '',
    embedding vector(${CATALOG_EMBEDDING_DIMENSIONS}),
    document tsvector,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_uuid, resource_type, resource_uuid)
)`,
        `CREATE INDEX IF NOT EXISTS catalog_index_embedding_idx ON "${s}"."${AGENT_EXT_TABLES.catalogIndex}" USING hnsw (embedding vector_cosine_ops)`,
        `CREATE INDEX IF NOT EXISTS catalog_index_document_idx ON "${s}"."${AGENT_EXT_TABLES.catalogIndex}" USING gin (document)`,
        `CREATE INDEX IF NOT EXISTS catalog_index_project_idx ON "${s}"."${AGENT_EXT_TABLES.catalogIndex}" (project_uuid)`,
        `INSERT INTO "${s}"."${AGENT_EXT_TABLES.migrations}" (version) VALUES ('${AGENT_EXT_MIGRATION_VERSION}') ON CONFLICT (version) DO NOTHING`,
    ];
}

// Real reversal: removes this version's tables and ledger row, and keeps the
// schema and extensions because later versions may still need them.
export function buildRollbackStatements(schema?: string): string[] {
    const s = resolveSchemaName(schema);
    return [
        `SET LOCAL lock_timeout = '60s'`,
        `DELETE FROM "${s}"."${AGENT_EXT_TABLES.migrations}" WHERE version = '${AGENT_EXT_MIGRATION_VERSION}'`,
        `DROP TABLE IF EXISTS "${s}"."${AGENT_EXT_TABLES.catalogIndex}"`,
        `DROP TABLE IF EXISTS "${s}"."${AGENT_EXT_TABLES.auditLogs}"`,
        `DROP TABLE IF EXISTS "${s}"."${AGENT_EXT_TABLES.skills}"`,
        `DROP TABLE IF EXISTS "${s}"."${AGENT_EXT_TABLES.messages}"`,
        `DROP TABLE IF EXISTS "${s}"."${AGENT_EXT_TABLES.threads}"`,
    ];
}
