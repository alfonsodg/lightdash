// Slice 1 (TDD red): project-scoped skill CRUD over agent_ext.skills.
import { describe, expect, it } from 'vitest';
import { createSkillStore, type SkillQueryClient } from './skillRepository';

const PROJECT = '22222222-2222-4222-8222-222222222222';

const setup = () => {
    const queries: Array<{ params: unknown[]; text: string }> = [];
    const queued: Array<Array<Record<string, unknown>>> = [];
    const db: SkillQueryClient = {
        query: async (text: string, params?: unknown[]) => {
            queries.push({ params: params ?? [], text });
            return { rows: queued.shift() ?? [] };
        },
    };
    return { db, queries, queued };
};

const skillRow = (overrides: Record<string, unknown> = {}) => ({
    created_at: '2026-01-02T03:04:05.000Z',
    enabled: true,
    manifest: { description: 'Shop metrics' },
    project_uuid: PROJECT,
    skill_uuid: 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
    slug: 'shop-metrics',
    updated_at: '2026-01-02T03:04:05.000Z',
    version: '1',
    ...overrides,
});

describe('skill store', () => {
    it('lists enabled skills scoped to the project', async () => {
        const { db, queries, queued } = setup();
        queued.push([skillRow(), skillRow({ slug: 'other' })]);
        const store = createSkillStore(db);
        const skills = await store.listSkills({ projectUuid: PROJECT });
        expect(skills.map((skill) => skill.slug)).toEqual([
            'shop-metrics',
            'other',
        ]);
        expect(queries[0]?.text).toContain('FROM "agent_ext"."skills"');
        expect(queries[0]?.text).toContain('project_uuid');
    });

    it('returns null for an unknown slug', async () => {
        const { db } = setup();
        const store = createSkillStore(db);
        await expect(
            store.getSkillBySlug({ projectUuid: PROJECT, slug: 'nope' }),
        ).resolves.toBeNull();
    });

    it('creates a skill with manifest and version', async () => {
        const { db, queries, queued } = setup();
        queued.push([skillRow()]);
        const store = createSkillStore(db);
        const created = await store.createSkill({
            manifest: { description: 'Shop metrics' },
            projectUuid: PROJECT,
            slug: 'shop-metrics',
        });
        expect(created.slug).toBe('shop-metrics');
        expect(queries[0]?.text).toContain('INSERT INTO "agent_ext"."skills"');
        expect(queries[0]?.params.slice(0, 2)).toEqual([
            PROJECT,
            'shop-metrics',
        ]);
    });

    it('rejects blank slugs without touching the database', async () => {
        const { db, queries } = setup();
        const store = createSkillStore(db);
        await expect(
            store.createSkill({
                manifest: {},
                projectUuid: PROJECT,
                slug: ' ',
            }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(queries).toHaveLength(0);
    });

    it('updates a skill only within its project', async () => {
        const { db, queries, queued } = setup();
        queued.push([skillRow({ enabled: false })]);
        const store = createSkillStore(db);
        const updated = await store.updateSkill({
            patch: { enabled: false },
            projectUuid: PROJECT,
            skillUuid: 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
        });
        expect(updated?.enabled).toBe(false);
        expect(queries[0]?.text).toContain('project_uuid');
    });

    it('reports missing skills on update', async () => {
        const { db } = setup();
        const store = createSkillStore(db);
        await expect(
            store.updateSkill({
                patch: { enabled: false },
                projectUuid: PROJECT,
                skillUuid: 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee',
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('deletes a skill within its project', async () => {
        const { db, queries, queued } = setup();
        queued.push([skillRow()]);
        const store = createSkillStore(db);
        await store.deleteSkill({
            projectUuid: PROJECT,
            skillUuid: 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
        });
        expect(queries[0]?.text).toContain('DELETE FROM "agent_ext"."skills"');
        expect(queries[0]?.params).toEqual([
            'dddddddd-dddd-4ddd-dddd-dddddddddddd',
            PROJECT,
        ]);
    });

    it('reports missing skills on delete', async () => {
        const { db } = setup();
        const store = createSkillStore(db);
        await expect(
            store.deleteSkill({
                projectUuid: PROJECT,
                skillUuid: 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee',
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});
