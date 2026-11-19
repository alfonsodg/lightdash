import { describe, expect, it } from 'vitest';
import {
    buildCatalogDocuments,
    buildCatalogLexicalSearchStatement,
    diffCatalogDocuments,
    filterCatalogHits,
    searchCatalogDocuments,
    syncCatalogIndex,
    uuidFromParts,
    type CatalogDocument,
    type CatalogExploreInput,
    type CatalogIndexStore,
    type CatalogVisibility,
} from './catalogIndexer';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';

const exploreInput = (overrides: Partial<CatalogExploreInput> = {}) => ({
    name: 'orders',
    label: 'Orders',
    description: 'Customer orders',
    tags: ['finance'],
    baseTable: 'orders',
    tables: {
        orders: {
            name: 'orders',
            label: 'Orders',
            description: 'Orders table',
            dimensions: {
                order_id: {
                    name: 'order_id',
                    label: 'Order id',
                    description: 'Primary key',
                    type: 'string',
                },
                created_at: {
                    name: 'created_at',
                    label: 'Created at',
                    description: 'Row creation time',
                    type: 'timestamp',
                    timeInterval: 'day',
                },
            },
            metrics: {
                total_revenue: {
                    name: 'total_revenue',
                    label: 'Total revenue',
                    description: 'Sum of order totals',
                    type: 'sum',
                },
            },
        },
    },
    ...overrides,
});

const visibilityAll = (): CatalogVisibility => ({
    allowedExplores: new Set(['orders']),
});

const fakeStore = (
    rows: Array<{
        resourceType: string;
        resourceUuid: string;
        content: string;
    }> = [],
) => {
    const state = {
        rows: [...rows],
        upserted: 0,
        deleted: 0,
    };
    const store: CatalogIndexStore = {
        listExisting: async () => [...state.rows],
        upsertRows: async (next: CatalogDocument[]) => {
            state.upserted += next.length;
            for (const document of next) {
                state.rows = state.rows.filter(
                    (row) =>
                        `${row.resourceType}|${row.resourceUuid}` !==
                        `${document.resourceType}|${document.resourceUuid}`,
                );
                state.rows.push({
                    resourceType: document.resourceType,
                    resourceUuid: document.resourceUuid,
                    content: document.content,
                });
            }
        },
        deleteKeys: async (keys) => {
            state.deleted += keys.length;
            const doomed = new Set(
                keys.map((key) => `${key.resourceType}|${key.resourceUuid}`),
            );
            state.rows = state.rows.filter(
                (row) => !doomed.has(`${row.resourceType}|${row.resourceUuid}`),
            );
        },
    };
    return { state, store };
};

describe('buildCatalogDocuments', () => {
    it('indexes explore, dimension, metric, description, and time dimension docs', () => {
        const documents = buildCatalogDocuments(PROJECT_UUID, [exploreInput()]);

        expect(documents).toHaveLength(4);
        expect(documents.map((doc) => doc.resourceType).sort()).toEqual([
            'dimension',
            'dimension',
            'explore',
            'metric',
        ]);
        const timeDimension = documents.find(
            (doc) => doc.fieldName === 'created_at',
        );
        expect(timeDimension?.content).toContain('day');
        expect(timeDimension?.content).toContain('Row creation time');
    });

    it('is deterministic across runs', () => {
        const first = buildCatalogDocuments(PROJECT_UUID, [exploreInput()]);
        const second = buildCatalogDocuments(PROJECT_UUID, [exploreInput()]);

        expect(second).toEqual(first);
        expect(
            uuidFromParts('catalog', PROJECT_UUID, 'explore', 'orders'),
        ).toBe(first[0]?.resourceUuid);
    });

    it('skips hidden fields', () => {
        const { tables } = exploreInput();
        const documents = buildCatalogDocuments(PROJECT_UUID, [
            exploreInput({
                tables: {
                    orders: {
                        ...tables.orders,
                        dimensions: {
                            ...tables.orders.dimensions,
                            order_id: {
                                ...tables.orders.dimensions.order_id,
                                hidden: true,
                            },
                        },
                    },
                },
            }),
        ]);

        expect(documents.some((doc) => doc.fieldName === 'order_id')).toBe(
            false,
        );
    });

    it('rejects invalid project identifiers and duplicate explores', () => {
        expect(() => buildCatalogDocuments('not-a-uuid', [])).toThrow(
            'Invalid project identifier',
        );
        expect(() =>
            buildCatalogDocuments(PROJECT_UUID, [
                exploreInput(),
                exploreInput(),
            ]),
        ).toThrow('Duplicate explore');
    });
});

describe('syncCatalogIndex', () => {
    it('inserts on first sync and reports no changes on repeat sync', async () => {
        const { state, store } = fakeStore();

        const first = await syncCatalogIndex(store, PROJECT_UUID, [
            exploreInput(),
        ]);
        expect(first).toEqual({ upserted: 4, removed: 0, unchanged: 0 });

        const second = await syncCatalogIndex(store, PROJECT_UUID, [
            exploreInput(),
        ]);
        expect(second).toEqual({ upserted: 0, removed: 0, unchanged: 4 });
        expect(state.upserted).toBe(4);
    });

    it('upserts only the changed document', async () => {
        const { store } = fakeStore();
        await syncCatalogIndex(store, PROJECT_UUID, [exploreInput()]);

        const changed = exploreInput({ description: 'Updated orders view' });
        const result = await syncCatalogIndex(store, PROJECT_UUID, [changed]);

        expect(result).toEqual({ upserted: 1, removed: 0, unchanged: 3 });
    });

    it('removes documents for explores that disappeared', async () => {
        const { store } = fakeStore();
        await syncCatalogIndex(store, PROJECT_UUID, [
            exploreInput(),
            exploreInput({
                name: 'customers',
                label: 'Customers',
                tables: {
                    customers: {
                        name: 'customers',
                        dimensions: {},
                        metrics: {},
                    },
                },
            }),
        ]);

        const result = await syncCatalogIndex(store, PROJECT_UUID, [
            exploreInput(),
        ]);
        expect(result.removed).toBe(1);
        expect(result.upserted).toBe(0);
    });

    it('clears the project index when explores are empty', async () => {
        const { state, store } = fakeStore();
        await syncCatalogIndex(store, PROJECT_UUID, [exploreInput()]);
        expect(state.rows.length).toBeGreaterThan(0);

        const result = await syncCatalogIndex(store, PROJECT_UUID, []);
        expect(result.removed).toBeGreaterThan(0);
        expect(state.rows).toHaveLength(0);
    });
});

describe('diffCatalogDocuments', () => {
    it('treats identical content as unchanged', () => {
        const desired = buildCatalogDocuments(PROJECT_UUID, [exploreInput()]);
        const existing = desired.map((doc) => ({
            resourceType: doc.resourceType,
            resourceUuid: doc.resourceUuid,
            content: doc.content,
        }));

        expect(diffCatalogDocuments(existing, desired)).toEqual({
            upsert: [],
            remove: [],
            unchanged: desired.length,
        });
    });
});

describe('searchCatalogDocuments', () => {
    it('ranks name matches above description-only matches', () => {
        const documents = buildCatalogDocuments(PROJECT_UUID, [exploreInput()]);

        const hits = searchCatalogDocuments(
            documents,
            'revenue',
            visibilityAll(),
        );
        expect(hits[0]?.document.fieldName).toBe('total_revenue');
    });

    it('filters hits against the caller-supplied visibility lists', () => {
        const documents = buildCatalogDocuments(PROJECT_UUID, [exploreInput()]);
        const denied: CatalogVisibility = { allowedExplores: new Set() };

        expect(
            searchCatalogDocuments(documents, 'orders', denied),
        ).toHaveLength(0);

        const fieldRestricted: CatalogVisibility = {
            allowedExplores: new Set(['orders']),
            allowedFieldsByExplore: new Map([
                ['orders', new Set(['orders.created_at'])],
            ]),
        };
        const hits = searchCatalogDocuments(
            documents,
            'orders',
            fieldRestricted,
        );
        expect(
            hits.some((hit) => hit.document.fieldName === 'total_revenue'),
        ).toBe(false);
        expect(
            hits.some((hit) => hit.document.resourceType === 'explore'),
        ).toBe(true);
        expect(
            hits.some((hit) => hit.document.fieldName === 'created_at'),
        ).toBe(true);
    });

    it('returns no hits for empty queries', () => {
        const documents = buildCatalogDocuments(PROJECT_UUID, [exploreInput()]);
        expect(
            searchCatalogDocuments(documents, '   ', visibilityAll()),
        ).toEqual([]);
    });

    it('filterCatalogHits drops disallowed explores', () => {
        const documents = buildCatalogDocuments(PROJECT_UUID, [exploreInput()]);
        const hits = documents.map((document) => ({ document, score: 1 }));

        const kept = filterCatalogHits(hits, visibilityAll());
        expect(kept).toHaveLength(hits.length);
        expect(
            filterCatalogHits(hits, { allowedExplores: new Set() }),
        ).toHaveLength(0);
    });
});

describe('buildCatalogLexicalSearchStatement', () => {
    it('targets the extension catalog table with bounded limits', () => {
        const statement = buildCatalogLexicalSearchStatement(
            PROJECT_UUID,
            'revenue',
            500,
        );

        expect(statement.text).toContain('agent_ext"."catalog_index');
        expect(statement.text).toContain('plainto_tsquery');
        expect(statement.params).toEqual([PROJECT_UUID, 'revenue', 100]);
    });
});
