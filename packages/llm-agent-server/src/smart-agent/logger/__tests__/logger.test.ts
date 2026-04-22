import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConsoleLogger } from '../console-logger.js';

/**
 * @deprecated Legacy SmartAgent event-logger suite.
 *
 * The old pipeline-event assertions are obsolete after the runtime moved to
 * session-step logging (`sessionLogger.logStep(...)`) in the smart stack.
 * Keep this file as a minimal regression guard for ConsoleLogger behavior.
 */

describe('ConsoleLogger — enabled=true writes JSON to stderr', () => {
  it('valid JSON line with timestamp written to stderr', () => {
    const logger = new ConsoleLogger(true);
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);

    try {
      process.stderr.write = ((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;

      logger.log({
        type: 'classify',
        traceId: 'trace-1',
        ts: new Date().toISOString(),
        inputLength: 1,
        subpromptCount: 1,
        durationMs: 0,
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.ok(writes.length > 0);
    const raw = writes.join('');
    const line = raw.trim().split('\n').at(-1) ?? '';
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed.type, 'classify');
    assert.equal(parsed.traceId, 'trace-1');
    assert.equal(typeof parsed.ts, 'string');
  });
});

describe('ConsoleLogger — enabled=false is silent', () => {
  it('no output to stderr when disabled', () => {
    const logger = new ConsoleLogger(false);
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);

    try {
      process.stderr.write = ((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;

      logger.log({
        type: 'classify',
        traceId: 'trace-2',
        ts: new Date().toISOString(),
        inputLength: 1,
        subpromptCount: 1,
        durationMs: 0,
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(writes.length, 0);
  });
});
