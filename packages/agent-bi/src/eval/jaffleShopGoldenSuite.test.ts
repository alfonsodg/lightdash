import { describe, expect, it } from 'vitest';
import {
    JAFFLE_SHOP_GOLDEN_TASKS,
    runGoldenTask,
} from './jaffleShopGoldenSuite';

describe('jaffleShopGoldenSuite', () => {
    it('defines at least 15 golden tasks', () => {
        expect(JAFFLE_SHOP_GOLDEN_TASKS.length).toBeGreaterThanOrEqual(15);
    });

    it.each(JAFFLE_SHOP_GOLDEN_TASKS.map((task) => [task.name, task] as const))(
        'passes golden task %s',
        (_name, task) => {
            expect(runGoldenTask(task)).toBe(true);
        },
    );
});
