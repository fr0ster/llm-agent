import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult } from '../interfaces/rag.js';
import type { ITextLogger } from '../logger/text-logger.js';
import type { LogEvent } from '../logger/types.js';
import { composeResilientEmbedder } from './embedder-resilience.js';

class BatchProvider {
  readonly maxBatchSize = 250;
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    return texts.map(() => ({ vector: [0] }));
  }
}

function recordingTextLogger(): {
  logger: ITextLogger;
  calls: Array<{ level: string; message: string; meta?: unknown }>;
} {
  const calls: Array<{ level: string; message: string; meta?: unknown }> = [];
  const push = (level: string) => (message: string, meta?: unknown) => {
    calls.push({ level, message, meta });
  };
  return {
    calls,
    logger: {
      info: push('info'),
      error: push('error'),
      warn: push('warn'),
      debug: push('debug'),
    },
  };
}

describe('composeResilientEmbedder with a text logger', () => {
  it('reports the maxBatchSize conflict through an ITextLogger', () => {
    const { logger, calls } = recordingTextLogger();

    // First composition fixes the cap at the provider's own 250.
    const composed = composeResilientEmbedder(new BatchProvider());
    // Re-composing with a DIFFERENT explicit cap is the path that warns.
    composeResilientEmbedder(composed, { explicitMaxBatchSize: 99, logger });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].level, 'warn');
    // A `warning` carries its own text as the message, per §7.
    assert.match(calls[0].message, /already composed with maxBatchSize 250/);
    // ...and the whole event travels as meta.
    assert.equal((calls[0].meta as LogEvent).type, 'warning');
  });

  it('still accepts the event logger on the same path, unchanged', () => {
    const events: LogEvent[] = [];

    const composed = composeResilientEmbedder(new BatchProvider());
    composeResilientEmbedder(composed, {
      explicitMaxBatchSize: 99,
      logger: { log: (e: LogEvent) => void events.push(e) },
    });

    assert.deepEqual(
      events.map((e) => e.type),
      ['warning'],
    );
  });
});
