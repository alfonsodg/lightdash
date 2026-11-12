// Slice 2: SSE stream parsing.
import { describe, expect, it, vi } from 'vitest';
import { streamThreadTurn } from './useAgentBiStream';

const encode = (text: string): ReadableStream<Uint8Array> => {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
};

describe('streamThreadTurn', () => {
    it('sends the current dashboard context with the prompt', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, body: encode('') }));
        vi.stubGlobal('fetch', fetchMock);
        const pinnedContext = { kind: 'dashboard' as const, slug: 'revenue' };
        const runtimeOverrides = {
            activeTab: 'Overview',
            filters: { dimensions: [{ fieldId: 'region', values: ['EU'] }] },
            parameters: { currency: 'EUR' },
        };

        await streamThreadTurn(
            {
                pinnedContext,
                projectUuid: 'p',
                runtimeOverrides,
                threadUuid: 't',
                userText: 'What changed?',
            },
            () => {},
        );

        expect(fetchMock).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                body: JSON.stringify({
                    pinnedContext,
                    runtimeOverrides,
                    userText: 'What changed?',
                }),
            }),
        );
    });

    it('parses SSE events from the turn endpoint', async () => {
        const body = encode(
            'event: text_delta\ndata: {"text":"Hel"}\n\n' +
                'event: done\ndata: {"text":"Hello"}\n\n',
        );
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, body })),
        );
        const events: Array<{ type: string }> = [];
        await streamThreadTurn(
            { projectUuid: 'p', threadUuid: 't', userText: 'Hi' },
            (event) => {
                events.push(event);
            },
        );
        expect(events.map((event) => event.type)).toEqual([
            'text_delta',
            'done',
        ]);
        expect(events[0]).toEqual({
            data: { text: 'Hel' },
            type: 'text_delta',
        });
    });

    it('throws when the response is not ok', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false, body: encode('') })),
        );
        let caught: unknown;
        try {
            await streamThreadTurn(
                { projectUuid: 'p', threadUuid: 't' },
                () => {},
            );
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe('Stream request failed');
    });
});
