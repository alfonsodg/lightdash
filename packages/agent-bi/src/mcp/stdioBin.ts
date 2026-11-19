#!/usr/bin/env node
import { runStdioCli } from './stdioCli';

runStdioCli().catch((error: unknown) => {
    const message =
        error instanceof Error ? error.message : 'The CLI failed to start.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
});
