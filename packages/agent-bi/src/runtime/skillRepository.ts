// Project-scoped markdown skills over agent_ext.skills. Role checks
// (viewer read, editor write) live with the caller; this store scopes
// every row to its project.
import { toISOString } from '../db/rowMappers';

export interface SkillQueryClient {
    query(
        text: string,
        params?: unknown[],
    ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface SkillRecord {
    createdAt: string;
    enabled: boolean;
    manifest: unknown;
    projectUuid: string | null;
    skillUuid: string;
    slug: string;
    updatedAt: string;
    version: string;
}

export type SkillStoreErrorCode = 'FORBIDDEN' | 'INVALID_INPUT' | 'NOT_FOUND';

export class SkillStoreError extends Error {
    readonly code: SkillStoreErrorCode;

    constructor(code: SkillStoreErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = 'SkillStoreError';
    }
}

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_SLUG_CHARS = 256;

const assertUuid = (name: string, value: string): void => {
    if (!UUID_PATTERN.test(value)) {
        throw new SkillStoreError(
            'INVALID_INPUT',
            `${name} must be a valid UUID.`,
        );
    }
};

const assertSlug = (slug: string): string => {
    const trimmed = slug.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_SLUG_CHARS) {
        throw new SkillStoreError(
            'INVALID_INPUT',
            'Skill slug must be between 1 and 256 characters.',
        );
    }
    return trimmed;
};

const toSkillRecord = (row: Record<string, unknown>): SkillRecord => ({
    createdAt: toISOString(row.created_at),
    enabled: row.enabled === true,
    manifest: row.manifest ?? {},
    projectUuid: typeof row.project_uuid === 'string' ? row.project_uuid : null,
    skillUuid: String(row.skill_uuid ?? ''),
    slug: typeof row.slug === 'string' ? row.slug : '',
    updatedAt: toISOString(row.updated_at),
    version: typeof row.version === 'string' ? row.version : '1',
});

const SKILL_COLUMNS =
    'skill_uuid, project_uuid, slug, version, manifest, enabled, created_at, updated_at';

export const createSkillStore = (db: SkillQueryClient) => ({
    createSkill: async (input: {
        enabled?: boolean;
        manifest: unknown;
        projectUuid: string;
        slug: string;
        version?: string;
    }): Promise<SkillRecord> => {
        assertUuid('projectUuid', input.projectUuid);
        const slug = assertSlug(input.slug);
        const { rows } = await db.query(
            `INSERT INTO "agent_ext"."skills" (project_uuid, slug, version, manifest, enabled) VALUES ($1, $2, $3, $4, $5) RETURNING ${SKILL_COLUMNS}`,
            [
                input.projectUuid,
                slug,
                input.version ?? '1',
                JSON.stringify(input.manifest ?? {}),
                input.enabled ?? true,
            ],
        );
        const row = rows[0];
        if (row === undefined) {
            throw new SkillStoreError('NOT_FOUND', 'Skill was not created.');
        }
        return toSkillRecord(row);
    },
    getSkillBySlug: async (input: {
        projectUuid: string;
        slug: string;
    }): Promise<SkillRecord | null> => {
        assertUuid('projectUuid', input.projectUuid);
        const { rows } = await db.query(
            `SELECT ${SKILL_COLUMNS} FROM "agent_ext"."skills" WHERE project_uuid = $1 AND slug = $2`,
            [input.projectUuid, input.slug],
        );
        const row = rows[0];
        return row === undefined ? null : toSkillRecord(row);
    },
    listSkills: async (input: {
        includeDisabled?: boolean;
        projectUuid: string;
    }): Promise<SkillRecord[]> => {
        assertUuid('projectUuid', input.projectUuid);
        const disabledFilter =
            input.includeDisabled === true ? '' : ' AND enabled = true';
        const { rows } = await db.query(
            `SELECT ${SKILL_COLUMNS} FROM "agent_ext"."skills" WHERE project_uuid = $1${disabledFilter} ORDER BY slug ASC`,
            [input.projectUuid],
        );
        return rows.map(toSkillRecord);
    },
    deleteSkill: async (input: {
        projectUuid: string;
        skillUuid: string;
    }): Promise<void> => {
        assertUuid('projectUuid', input.projectUuid);
        assertUuid('skillUuid', input.skillUuid);
        const { rows } = await db.query(
            'DELETE FROM "agent_ext"."skills" WHERE skill_uuid = $1 AND project_uuid = $2 RETURNING skill_uuid',
            [input.skillUuid, input.projectUuid],
        );
        if (rows[0] === undefined) {
            throw new SkillStoreError('NOT_FOUND', 'Skill was not found.');
        }
    },
    updateSkill: async (input: {
        patch: {
            enabled?: boolean;
            manifest?: unknown;
            version?: string;
        };
        projectUuid: string;
        skillUuid: string;
    }): Promise<SkillRecord> => {
        assertUuid('projectUuid', input.projectUuid);
        assertUuid('skillUuid', input.skillUuid);
        const sets: string[] = ['updated_at = now()'];
        const params: unknown[] = [];
        if (input.patch.manifest !== undefined) {
            params.push(JSON.stringify(input.patch.manifest));
            sets.push(`manifest = $${params.length}`);
        }
        if (input.patch.enabled !== undefined) {
            params.push(input.patch.enabled);
            sets.push(`enabled = $${params.length}`);
        }
        if (input.patch.version !== undefined) {
            params.push(input.patch.version);
            sets.push(`version = $${params.length}`);
        }
        if (params.length === 0) {
            throw new SkillStoreError('INVALID_INPUT', 'Nothing to update.');
        }
        params.push(input.skillUuid, input.projectUuid);
        const { rows } = await db.query(
            `UPDATE "agent_ext"."skills" SET ${sets.join(', ')} WHERE skill_uuid = $${params.length - 1} AND project_uuid = $${params.length} RETURNING ${SKILL_COLUMNS}`,
            params,
        );
        const row = rows[0];
        if (row === undefined) {
            throw new SkillStoreError('NOT_FOUND', 'Skill was not found.');
        }
        return toSkillRecord(row);
    },
});

export type SkillStore = ReturnType<typeof createSkillStore>;
