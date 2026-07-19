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
  assert.deepEqual(
    (requestStep?.data as { messages: Message[] }).messages,
    messages,
  );

  const responseStep = spySession.steps.find(
    (s) => s.name === 'llm_response_pass',
  );
  assert.ok(responseStep, 'expected an llm_response_pass step to be logged');
  assert.equal(responseStep?.area, 'llm');
});
