import {
  type ILlm,
  LlmError,
  type LlmResponse,
  type LlmStreamChunk,
  type Result,
} from '@mcp-abap-adt/llm-agent';

type Scripted = { content: string } | Error;

/**
 * Scripted ILlm, typed — no cast: `chat` and `streamChat` answer with the
 * queued responses in order; an `Error` becomes `{ ok: false, error: LlmError }`;
 * an empty queue answers `'default'` (the behaviour of libs' `makeLlm`, which
 * `reranker.test.ts` used before the move — this package must not import libs).
 */
export function makeLlm(responses: Scripted[]): ILlm & { callCount: number } {
  let callCount = 0;
  const queue = [...responses];
  const nextResult = (): Result<LlmResponse, LlmError> => {
    callCount++;
    const next = queue.shift();
    if (next instanceof Error)
      return { ok: false, error: new LlmError(next.message) };
    return {
      ok: true,
      value: { content: next?.content ?? 'default', finishReason: 'stop' },
    };
  };
  return {
    get callCount() {
      return callCount;
    },
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return nextResult();
    },
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      const r = nextResult();
      yield r.ok
        ? {
            ok: true,
            value: { content: r.value.content, finishReason: 'stop' },
          }
        : r;
    },
  };
}
