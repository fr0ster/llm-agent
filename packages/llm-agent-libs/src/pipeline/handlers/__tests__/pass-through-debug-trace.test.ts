/**
 * Regression test for the debug-trace review finding: the pass-through
 * pipeline path (`mode === 'pass'`) must emit a TAGGED (`area: 'llm'`)
 * request record in addition to the existing (now tagged) response record,
 * so DEBUG_LLM=1 (area-only `SessionLogger`) actually captures pass-through
 * traffic instead of silently dropping it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IRequestLogger,
  LlmCallEntry,
  LlmError,
  LlmStreamChunk,
  LlmTool,
  Message,
  RagQueryEntry,
  RequestSummary,
  Result,
  ToolCallEntry,
} from '@mcp-abap-adt/llm-agent';
import { runPassThrough } from '../pass-through.js';

interface LoggedStep {
  name: string;
  data: unknown;
  area?: string;
}

class SpySessionLogger {
  readonly steps: LoggedStep[] = [];
  logStep(name: string, data: unknown, area?: string): void {
    this.steps.push({ name, data, area });
  }
}

class NoopRequestLogger implements IRequestLogger {
  logLlmCall(_e: LlmCallEntry): void {}
  logRagQuery(_e: RagQueryEntry): void {}
  logToolCall(_e: ToolCallEntry): void {}
  startRequest(): void {}
  endRequest(): void {}
  dropRequest(): void {}
  getSummary(): RequestSummary {
    return {
      byModel: {},
      byComponent: {},
      byCategory: {},
      ragQueries: 0,
      toolCalls: 0,
      totalDurationMs: 0,
    };
  }
  reset(): void {}
}

/** LLM whose streamChat yields exactly one content chunk, then completes. */
function oneChunkLlm(): ILlm {
  return {
    model: 'test-model',
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      yield {
        ok: true,
        value: { content: 'hello', finishReason: 'stop' },
      } as Result<LlmStreamChunk, LlmError>;
    },
  } as unknown as ILlm;
}

test('runPassThrough emits tagged llm_request_pass and llm_response_pass records under DEBUG_LLM', async () => {
  const llm = oneChunkLlm();
  const requestLogger = new NoopRequestLogger();
  const spySession = new SpySessionLogger();
  const messages: Message[] = [{ role: 'user', content: 'hi' }];
  const tools: LlmTool[] = [];
  const opts: CallOptions = {
    sessionLogger: spySession,
  } as unknown as CallOptions;

  const chunks: unknown[] = [];
  for await (const chunk of runPassThrough(
    llm,
    requestLogger,
    messages,
    tools,
    opts,
  )) {
    chunks.push(chunk);
  }

  assert.ok(chunks.length > 0);

  const requestStep = spySession.steps.find(
    (s) => s.name === 'llm_request_pass',
  );
  assert.ok(requestStep, 'expected an llm_request_pass step to be logged');
  assert.equal(requestStep?.area, 'llm');
  const requestData = requestStep?.data as { messages: Message[] } | undefined;
  assert.deepEqual(requestData?.messages, messages);

  const responseStep = spySession.steps.find(
    (s) => s.name === 'llm_response_pass',
  );
  assert.ok(responseStep, 'expected an llm_response_pass step to be logged');
  assert.equal(responseStep?.area, 'llm');
});

/** LLM that yields some content and then fails, the way a stream dies midway. */
function failsMidStreamLlm(): ILlm {
  return {
    model: 'test-model',
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      yield {
        ok: true,
        value: { content: 'partial ' },
      } as Result<LlmStreamChunk, LlmError>;
      const error = Object.assign(new Error('SAP AI SDK streaming error'), {
        code: 'LLM_ERROR',
        cause: new Error('socket hang up'),
      });
      yield { ok: false, error } as unknown as Result<LlmStreamChunk, LlmError>;
    },
  } as unknown as ILlm;
}

test('runPassThrough records the response trace when the stream fails (#290)', async () => {
  // The failed call is the one the tracing exists for. Leaving on the error
  // path wrote the question and nothing else — no error text, no partial
  // content, nothing saying how far the stream got.
  const spySession = new SpySessionLogger();
  const opts = { sessionLogger: spySession } as unknown as CallOptions;

  for await (const _ of runPassThrough(
    failsMidStreamLlm(),
    new NoopRequestLogger(),
    [{ role: 'user', content: 'hi' }],
    [],
    opts,
  )) {
    // drain
  }

  const responseStep = spySession.steps.find(
    (s) => s.name === 'llm_response_pass',
  );
  assert.ok(responseStep, 'a failed stream must still record a response');
  assert.equal(responseStep?.area, 'llm');

  const data = responseStep?.data as {
    error?: { message?: string; code?: unknown; cause?: string[] };
    partialContent?: string;
    chunksSeen?: number;
  };
  assert.match(String(data.error?.message), /streaming error/);
  assert.equal(data.error?.code, 'LLM_ERROR');
  assert.deepEqual(data.error?.cause, ['socket hang up']);
  assert.equal(data.partialContent, 'partial ');
  assert.equal(
    data.chunksSeen,
    1,
    'one chunk arrived before the failure — this is what separates a stream that died halfway from one that never opened',
  );
});
