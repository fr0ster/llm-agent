// A test-only copy of `makeLlm` from @mcp-abap-adt/llm-agent's src/testing/index.ts,
// which is not a public entry point (spec §11.3).
import {
  type ILlm,
  LlmError,
  type LlmFinishReason,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmToolCall,
  type Result,
} from '@mcp-abap-adt/llm-agent';

export function makeLlm(
  responses: Array<
    | {
        content: string;
        toolCalls?: LlmToolCall[];
        finishReason?: LlmFinishReason;
      }
    | Error
  >,
): ILlm & { callCount: number } {
  let callCount = 0;
  const queue = [...responses];
  return {
    get callCount() {
      return callCount;
    },
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      callCount++;
      const next = queue.shift();
      if (!next) {
        return {
          ok: true,
          value: { content: 'default', finishReason: 'stop' },
        };
      }
      if (next instanceof Error) {
        return { ok: false, error: new LlmError(next.message) };
      }
      return {
        ok: true,
        value: {
          content: next.content,
          toolCalls: next.toolCalls,
          finishReason: next.finishReason ?? 'stop',
        },
      };
    },
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      callCount++;
      const next = queue.shift();
      if (!next) {
        yield {
          ok: true,
          value: { content: 'default', finishReason: 'stop' },
        };
        return;
      }
      if (next instanceof Error) {
        yield { ok: false, error: new LlmError(next.message) };
        return;
      }
      yield {
        ok: true,
        value: {
          content: next.content,
          toolCalls: next.toolCalls,
          finishReason: next.finishReason ?? 'stop',
        },
      };
    },
    async healthCheck(): Promise<Result<boolean, LlmError>> {
      const next = queue[0];
      if (next instanceof Error) {
        return { ok: false, error: new LlmError(next.message) };
      }
      return { ok: true, value: true };
    },
  };
}
