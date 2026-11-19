import { describe, expect, it } from 'vitest';
import { enMessages } from './locales/en';
import { esMessages } from './locales/es';

describe('agentBi i18n dictionaries', () => {
    it('maintains 100% key parity between es and en with non-empty values', () => {
        const esKeys = Object.keys(esMessages).sort();
        const enKeys = Object.keys(enMessages).sort();
        expect(enKeys).toEqual(esKeys);

        for (const key of esKeys) {
            const esVal = esMessages[key as keyof typeof esMessages];
            const enVal = enMessages[key as keyof typeof enMessages];
            expect(esVal.trim().length).toBeGreaterThan(0);
            expect(enVal.trim().length).toBeGreaterThan(0);
            expect(esVal.toLowerCase()).not.toContain('lightdash');
            expect(enVal.toLowerCase()).not.toContain('lightdash');
        }
    });
});
