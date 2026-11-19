import { configDefaults, defineConfig } from 'vitest/config';

// migrateUp hits the shared agent_ext schema, so these files race each
// other under parallel workers (duplicate pg_type key). They run serially.
const serialFiles = [
    'src/db/migrate.integration.test.ts',
    'src/tools/agentTools.live.test.ts',
    'src/export/exportTools.live.test.ts',
];

const shared = {
    environment: 'node',
    globals: true,
    env: {
        TZ: 'UTC',
        LANG: 'en_US.UTF-8',
        NODE_ENV: 'test',
    },
    maxWorkers: '50%',
};

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    ...shared,
                    name: 'agent-bi-unit-tests',
                    include: ['src/**/*.test.ts'],
                    exclude: [...configDefaults.exclude, ...serialFiles],
                    fileParallelism: true,
                    sequence: { groupOrder: 0 },
                },
            },
            {
                test: {
                    ...shared,
                    name: 'agent-bi-live-tests',
                    include: serialFiles,
                    fileParallelism: false,
                    sequence: { groupOrder: 1 },
                },
            },
        ],
    },
});
