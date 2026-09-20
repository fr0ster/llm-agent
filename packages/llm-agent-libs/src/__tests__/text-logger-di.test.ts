import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  IEmbedder,
  IEmbedResult,
  ILlm,
  ITextLogger,
  LlmStreamChunk,
  LlmTool,
  LogEvent,
  Result,
} from '@mcp-abap-adt/llm-agent';

/** Always fails validation — the startup path is the one that logs. */
function failingLlm(): ILlm {
  return {
    async chat(
      _m: unknown[],
      _t?: LlmTool[],
      _o?: CallOptions,
    ): Promise<Result<{ content: string; finishReason: 'stop' }, Error>> {
      return {
        ok: false as const,
        error: new Error('deployment list unavailable') as never,
      };
    },
    async *streamChat(): AsyncGenerator<Result<LlmStreamChunk, Error>> {
      yield {
        ok: true as const,
        value: { content: 'OK', finishReason: 'stop' as const },
      };
    },
  } as ILlm;
}

function stubEmbedder(): IEmbedder {
  return {
    async embed(_text: string, _o?: CallOptions): Promise<IEmbedResult> {
      return { vector: [0.1, 0.2, 0.3] };
    },
  };
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

describe('SmartAgentBuilder.withLogger() — text logger', () => {
  it('routes events to a text logger at the levels §7 fixes', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const { logger, calls } = recordingTextLogger();

    await assert.rejects(
      () =>
        new SmartAgentBuilder({
          modelValidationAttempts: 2,
          modelValidationBackoffMs: 1,
        })
          .withMainLlm(failingLlm())
          .withEmbedder(stubEmbedder())
          .withLogger(logger)
          .build(),
      /Startup aborted/,
    );

    assert.deepEqual(
      calls.map((c) => c.level),
      ['warn', 'error'],
    );
    // A `warning` carries its OWN text as the message — not the string 'warning'.
    assert.match(calls[0].message, /validation attempt 1 failed/);
    // Every other kind uses the event's type as the message.
    assert.equal(calls[1].message, 'pipeline_error');
    // The whole event travels as meta.
    assert.equal((calls[1].meta as LogEvent).type, 'pipeline_error');
  });

  it('the event logger still receives the same events, unchanged', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const events: LogEvent[] = [];

    await assert.rejects(
      () =>
        new SmartAgentBuilder({
          modelValidationAttempts: 2,
          modelValidationBackoffMs: 1,
        })
          .withMainLlm(failingLlm())
          .withEmbedder(stubEmbedder())
          .withLogger({ log: (e: LogEvent) => void events.push(e) })
          .build(),
      /Startup aborted/,
    );

    assert.deepEqual(
      events.map((e) => e.type),
      ['warning', 'pipeline_error'],
    );
  });
});

describe('SessionGraphFactory with a text logger', () => {
  it('surfaces a teardown failure through a text logger', async () => {
    const { SessionGraphFactory } = await import(
      '../session/session-graph-factory.js'
    );
    const { logger, calls } = recordingTextLogger();

    const ragRegistry = {
      closeSession: async () => {
        throw new Error('close failed');
      },
    } as never;

    const factory = new SessionGraphFactory({
      mcpClientFactory: () => [],
      toolsRag: undefined,
      ragRegistry,
      buildAgent: async () => undefined,
      logger,
    });

    const graph = await factory.build({ sessionId: 's1' });
    await graph.dispose();

    assert.ok(
      calls.some((c) => c.message.includes('session_close_failed')),
      'the teardown failure reached the text logger',
    );
  });
});
