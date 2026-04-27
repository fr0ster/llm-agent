/**
 * Minimal test-double factories for core package tests.
 *
 * Only exports stubs that depend solely on core interfaces.
 * Full test helpers (SmartAgent stubs, etc.) live in @mcp-abap-adt/llm-agent-server.
 */

import type { ILlm, IQueryEmbedding, IRag } from '../interfaces/index.js';
import {
  LlmError,
  type LlmFinishReason,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmToolCall,
  RagError,
  type RagResult,
  type Result,
} from '../interfaces/types.js';

// ---------------------------------------------------------------------------
// LLM stub
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// RAG stubs
// ---------------------------------------------------------------------------

export function makeRag(
  queryResults: RagResult[] = [],
): IRag & { upsertCalls: string[] } {
  const upsertCalls: string[] = [];
  const stub: IRag & { upsertCalls: string[] } = {
    upsertCalls,
    async query(
      _embedding: IQueryEmbedding,
    ): Promise<Result<RagResult[], RagError>> {
      return { ok: true, value: queryResults };
    },
    async healthCheck(): Promise<Result<void, RagError>> {
      return { ok: true, value: undefined };
    },
    async getById(_id: string): Promise<Result<RagResult | null, RagError>> {
      return { ok: true, value: null };
    },
    writer() {
      return {
        upsertRaw: async (
          _id: string,
          text: string,
        ): Promise<Result<void, RagError>> => {
          upsertCalls.push(text);
          return { ok: true, value: undefined };
        },
        deleteByIdRaw: async (
          _id: string,
        ): Promise<Result<boolean, RagError>> => {
          return { ok: true, value: false };
        },
      };
    },
  };
  return stub;
}
