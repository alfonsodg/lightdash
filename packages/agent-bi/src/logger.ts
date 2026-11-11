export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogMeta = Record<string, unknown>;

export interface LogSink {
    debug(message: string, meta?: LogMeta): void;
    info(message: string, meta?: LogMeta): void;
    warn(message: string, meta?: LogMeta): void;
    error(message: string, meta?: LogMeta): void;
}

export interface LoggerOptions {
    level?: LogLevel;
    sink?: LogSink;
}

const severity: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

export interface Logger extends LogSink {}

// Level-filtered logger; callers keep credentials out of message and meta.
export function createLogger(options: LoggerOptions = {}): Logger {
    const { level = 'info', sink = console } = options;
    const threshold = severity[level];
    const enabled = (candidate: LogLevel): boolean =>
        severity[candidate] >= threshold;
    return {
        debug: (message, meta) => {
            if (enabled('debug')) {
                sink.debug(message, meta);
            }
        },
        info: (message, meta) => {
            if (enabled('info')) {
                sink.info(message, meta);
            }
        },
        warn: (message, meta) => {
            if (enabled('warn')) {
                sink.warn(message, meta);
            }
        },
        error: (message, meta) => {
            if (enabled('error')) {
                sink.error(message, meta);
            }
        },
    };
}
