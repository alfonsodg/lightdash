import { describe, expect, it } from 'vitest';
import { createContentFetchClient } from '../content/contentFetch';
import { createExportFetchClient } from '../export/exportFetch';
import { AgentToolError } from './agentToolTypes';

describe('contentFetch and exportFetch runtime options', () => {
    it('propagates caller AbortSignal to fetchImpl in createContentFetchClient', async () => {
        const controller = new AbortController();
        let capturedSignal: AbortSignal | undefined;
        const client = createContentFetchClient({
            baseUrl: 'http://localhost:8080',
            fetchImpl: (_url, init) =>
                new Promise((_resolve, reject) => {
                    capturedSignal = init.signal ?? undefined;
                    init.signal?.addEventListener('abort', () => {
                        reject(new Error('aborted'));
                    });
                }),
        });

        const pending = client(
            { method: 'GET', path: '/api/v1/projects/p1/code/charts' },
            { signal: controller.signal },
        );
        controller.abort();

        await expect(pending).rejects.toBeInstanceOf(AgentToolError);
        expect(capturedSignal?.aborted).toBe(true);
    });

    it('enforces timeoutMs in createExportFetchClient', async () => {
        let capturedSignal: AbortSignal | undefined;
        const client = createExportFetchClient({
            baseUrl: 'http://localhost:8080',
            fetchImpl: (_url, init) =>
                new Promise((_resolve, reject) => {
                    capturedSignal = init.signal ?? undefined;
                    init.signal?.addEventListener('abort', () => {
                        reject(new Error('timed out'));
                    });
                }),
            timeoutMs: 15,
        });

        await expect(
            client({ method: 'POST', path: '/api/v1/saved/c1/export' }),
        ).rejects.toBeInstanceOf(AgentToolError);
        expect(capturedSignal?.aborted).toBe(true);
    });
});
