import { createCatalogExtRouter } from './agentBiCatalogRouter';

describe('agentBiCatalogRouter', () => {
    it('exports a valid Express router factory', () => {
        const router = createCatalogExtRouter();
        expect(typeof router).toBe('function');
        expect(Array.isArray(router.stack)).toBe(true);
        expect(router.stack.length).toBe(2);
    });
});
