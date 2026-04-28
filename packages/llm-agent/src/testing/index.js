/**
 * Minimal test-double factories for core package tests.
 *
 * Only exports stubs that depend solely on core interfaces.
 * Full test helpers (SmartAgent stubs, etc.) live in @mcp-abap-adt/llm-agent-server.
 */
import { LlmError } from '../interfaces/types.js';
// ---------------------------------------------------------------------------
// LLM stub
// ---------------------------------------------------------------------------
export function makeLlm(responses) {
  let callCount = 0;
  const queue = [...responses];
  return {
    get callCount() {
      return callCount;
    },
    async chat() {
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
    async *streamChat() {
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
    async healthCheck() {
      const next = queue[0];
      if (next instanceof Error) {
        return { ok: false, error: new LlmError(next.message) };
      }
      return { ok: true, value: true };
    },
  };
}
// ---------------------------------------------------------------------------
// RAG stubs
// ---------------------------------------------------------------------------
export function makeRag(queryResults = []) {
  const upsertCalls = [];
  const stub = {
    upsertCalls,
    async query(_embedding) {
      return { ok: true, value: queryResults };
    },
    async healthCheck() {
      return { ok: true, value: undefined };
    },
    async getById(_id) {
      return { ok: true, value: null };
    },
    writer() {
      return {
        upsertRaw: async (_id, text) => {
          upsertCalls.push(text);
          return { ok: true, value: undefined };
        },
        deleteByIdRaw: async (_id) => {
          return { ok: true, value: false };
        },
      };
    },
  };
  return stub;
}
//# sourceMappingURL=index.js.map
