import { describe, expect, it, vi } from 'vitest';
import { createLogger, type LogSink } from './logger';

function createRecordingSink(): LogSink & { calls: string[] } {
    const calls: string[] = [];
    const record = (level: string, message: string) => {
        calls.push(`${level}:${message}`);
    };
    return {
        calls,
        debug: (message) => record('debug', message),
        info: (message) => record('info', message),
        warn: (message) => record('warn', message),
        error: (message) => record('error', message),
    };
}

describe('createLogger', () => {
    it('emits every level at debug', () => {
        const sink = createRecordingSink();
        const logger = createLogger({ level: 'debug', sink });
        logger.debug('d');
        logger.info('i');
        logger.warn('w');
        logger.error('e');
        expect(sink.calls).toEqual(['debug:d', 'info:i', 'warn:w', 'error:e']);
    });

    it('suppresses levels below the threshold', () => {
        const sink = createRecordingSink();
        const logger = createLogger({ level: 'warn', sink });
        logger.debug('d');
        logger.info('i');
        logger.warn('w');
        logger.error('e');
        expect(sink.calls).toEqual(['warn:w', 'error:e']);
    });

    it('defaults to info level', () => {
        const sink = createRecordingSink();
        const logger = createLogger({ sink });
        logger.debug('d');
        logger.info('i');
        expect(sink.calls).toEqual(['info:i']);
    });

    it('forwards metadata to the sink', () => {
        const sink: LogSink = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        };
        createLogger({ level: 'debug', sink }).info('hello', { op: 'sync' });
        expect(sink.info).toHaveBeenCalledWith('hello', { op: 'sync' });
    });
});
