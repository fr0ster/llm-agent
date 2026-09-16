import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTextLogger, normaliseLogger } from './normalise-logger.js';
import type { ITextLogger } from './text-logger.js';
import type { LogEvent } from './types.js';

type Call = { level: string; message: string; meta?: unknown };

function recordingTextLogger(): { logger: ITextLogger; calls: Call[] } {
  const calls: Call[] = [];
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

describe('normaliseLogger', () => {
  it('returns an event logger unchanged — the existing path must not move', () => {
    const events: LogEvent[] = [];
    const eventLogger = { log: (e: LogEvent) => void events.push(e) };

    const normalised = normaliseLogger(eventLogger);

    assert.equal(normalised, eventLogger);
  });

  it('maps every LogEvent kind to the level §7 specifies', () => {
    const { logger, calls } = recordingTextLogger();
    const sink = normaliseLogger(logger);

    const events: LogEvent[] = [
      {
        type: 'classify',
        traceId: 't',
        inputLength: 1,
        subpromptCount: 1,
        durationMs: 1,
      },
      { type: 'rag_upsert', traceId: 't', store: 's', durationMs: 1 },
      {
        type: 'rag_query',
        traceId: 't',
        store: 's',
        k: 1,
        resultCount: 1,
        durationMs: 1,
      },
      {
        type: 'llm_call',
        traceId: 't',
        iteration: 1,
        finishReason: 'stop',
        durationMs: 1,
      },
      {
        type: 'tool_call',
        traceId: 't',
        toolName: 'x',
        isError: false,
        durationMs: 1,
      },
      {
        type: 'pipeline_done',
        traceId: 't',
        stopReason: 'done',
        iterations: 1,
        toolCallCount: 0,
        durationMs: 1,
      },
      {
        type: 'pipeline_error',
        traceId: 't',
        code: 'E',
        message: 'boom',
        durationMs: 1,
      },
      {
        type: 'tools_selected',
        traceId: 't',
        total: 5,
        selected: 2,
        names: ['a', 'b'],
      },
      { type: 'rag_translate', traceId: 't', original: 'a', translated: 'b' },
      { type: 'warning', traceId: 't', message: 'careful' },
    ];
    for (const event of events) sink.log(event);

    assert.deepEqual(
      calls.map((c) => c.level),
      [
        'info', // classify
        'debug', // rag_upsert
        'debug', // rag_query
        'info', // llm_call
        'info', // tool_call
        'info', // pipeline_done
        'error', // pipeline_error
        'debug', // tools_selected
        'info', // rag_translate
        'warn', // warning
      ],
    );
  });

  it('uses event.type as the message, except for warning', () => {
    const { logger, calls } = recordingTextLogger();
    const sink = normaliseLogger(logger);

    sink.log({
      type: 'llm_call',
      traceId: 't',
      iteration: 1,
      finishReason: 'stop',
      durationMs: 1,
    });
    sink.log({ type: 'warning', traceId: 't', message: 'careful' });

    assert.equal(calls[0].message, 'llm_call');
    assert.equal(calls[1].message, 'careful');
  });

  it('passes the whole event as meta, including for warning', () => {
    const { logger, calls } = recordingTextLogger();
    const sink = normaliseLogger(logger);
    const event: LogEvent = {
      type: 'warning',
      traceId: 't',
      message: 'careful',
    };

    sink.log(event);

    assert.deepEqual(calls[0].meta, event);
  });
});

describe('isTextLogger', () => {
  it('recognises a text logger and rejects an event logger', () => {
    const { logger } = recordingTextLogger();
    assert.equal(isTextLogger(logger), true);
    assert.equal(isTextLogger({ log: () => {} }), false);
  });

  it('an object satisfying BOTH shapes is treated as the event logger', () => {
    // Structural typing permits this: a text logger that also exposes `log`.
    // The contract says the event path wins, so that today's loggers keep
    // behaving exactly as they do today rather than being silently re-routed
    // through the level mapping.
    const events: LogEvent[] = [];
    const textCalls: string[] = [];
    const hybrid = {
      log: (e: LogEvent) => void events.push(e),
      info: (m: string) => void textCalls.push(m),
      error: (m: string) => void textCalls.push(m),
      warn: (m: string) => void textCalls.push(m),
      debug: (m: string) => void textCalls.push(m),
    };

    assert.equal(isTextLogger(hybrid), false);

    const normalised = normaliseLogger(hybrid);
    assert.equal(normalised, hybrid, 'returned unchanged, not wrapped');

    normalised.log({ type: 'warning', traceId: 't', message: 'careful' });
    assert.equal(events.length, 1, 'the event path received it');
    assert.deepEqual(textCalls, [], 'the text methods were never called');
  });
});
