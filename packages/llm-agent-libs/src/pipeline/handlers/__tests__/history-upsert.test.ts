import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  HistoryTurn,
  IHistoryMemory,
  IHistorySummarizer,
  IRag,
  LlmError,
  RagError,
  Result,
} from '@mcp-abap-adt/llm-agent';

import { InMemoryRag } from '@mcp-abap-adt/llm-agent';
import { summarizeAndStore } from '../history-upsert.js';

function makeFakeMemory(): IHistoryMemory & { entries: Map<string, string[]> } {
  const entries = new Map<string, string[]>();
  return {
    entries,
    pushRecent(sessionId: string, summary: string) {
      if (!entries.has(sessionId)) entries.set(sessionId, []);
      entries.get(sessionId)?.push(summary);
    },
    getRecent(sessionId: string, limit: number) {
      return (entries.get(sessionId) ?? []).slice(-limit);
    },
    clear(sessionId: string) {
      entries.delete(sessionId);
    },
  };
}

function makeFakeSummarizer(response: string): IHistorySummarizer {
  return {
    summarize: async () =>
      ({ ok: true, value: response }) as Result<string, LlmError>,
  };
}

function makeFakeRag(): IRag & {
  upserted: Array<{ id: string; text: string; meta: unknown }>;
} {
  const upserted: Array<{ id: string; text: string; meta: unknown }> = [];
  return {
    upserted,
    async query(): Promise<Result<[], RagError>> {
      return { ok: true, value: [] };
    },
    async healthCheck(): Promise<Result<void, RagError>> {
      return { ok: true, value: undefined };
    },
    async getById(): Promise<Result<null, RagError>> {
      return { ok: true, value: null };
    },
    writer() {
      return {
        upsertRaw: async (
          id: string,
          text: string,
          meta: unknown,
        ): Promise<Result<void, RagError>> => {
          upserted.push({ id, text, meta });
          return { ok: true, value: undefined };
        },
        deleteByIdRaw: async (): Promise<Result<boolean, RagError>> => ({
          ok: true,
          value: false,
        }),
      };
    },
  };
}

describe('history-upsert: summarizeAndStore', () => {
  it('summarizes turn, upserts to RAG, pushes to memory', async () => {
    const memory = makeFakeMemory();
    const summarizer = makeFakeSummarizer('Created class ZCL_TEST in ZDEV');
    const rag = makeFakeRag();

    const turn: HistoryTurn = {
      sessionId: 's1',
      turnIndex: 0,
      userText: 'create class ZCL_TEST',
      assistantText: 'Done',
      toolCalls: [{ name: 'createClass', arguments: { name: 'ZCL_TEST' } }],
      toolResults: [{ tool: 'createClass', content: 'success' }],
      timestamp: 1000,
    };

    await summarizeAndStore({
      turn,
      summarizer,
      memory,
      rag,
      sessionId: 's1',
    });

    assert.equal(rag.upserted.length, 1);
    assert.equal(rag.upserted[0].text, 'Created class ZCL_TEST in ZDEV');
    assert.equal(rag.upserted[0].id, 'turn:s1:0');
    assert.deepEqual(memory.getRecent('s1', 10), [
      'Created class ZCL_TEST in ZDEV',
    ]);
  });

  it('still pushes to memory when RAG writer is absent (best-effort)', async () => {
    const memory = makeFakeMemory();
    const summarizer = makeFakeSummarizer('summary text');
    // RAG with no writer
    const rag: IRag = {
      async query() {
        return { ok: true, value: [] };
      },
      async healthCheck() {
        return { ok: true, value: undefined };
      },
      async getById() {
        return { ok: true, value: null };
      },
    };

    const turn: HistoryTurn = {
      sessionId: 's1',
      turnIndex: 0,
      userText: 'x',
      assistantText: 'y',
      toolCalls: [],
      toolResults: [],
      timestamp: 1000,
    };

    await summarizeAndStore({
      turn,
      summarizer,
      memory,
      rag,
      sessionId: 's1',
    });
    assert.deepEqual(memory.getRecent('s1', 10), ['summary text']);
  });

  it('still pushes to memory when RAG upsertRaw fails (best-effort)', async () => {
    const memory = makeFakeMemory();
    const summarizer = makeFakeSummarizer('summary text');
    const rag: IRag = {
      async query() {
        return { ok: true, value: [] };
      },
      async healthCheck() {
        return { ok: true, value: undefined };
      },
      async getById() {
        return { ok: true, value: null };
      },
      writer() {
        return {
          upsertRaw: async () => ({
            ok: false as const,
            error: { message: 'RAG down' } as RagError,
          }),
          deleteByIdRaw: async () => ({ ok: true as const, value: false }),
        };
      },
    };

    const turn: HistoryTurn = {
      sessionId: 's1',
      turnIndex: 0,
      userText: 'x',
      assistantText: 'y',
      toolCalls: [],
      toolResults: [],
      timestamp: 1000,
    };

    await summarizeAndStore({
      turn,
      summarizer,
      memory,
      rag,
      sessionId: 's1',
    });
    assert.deepEqual(memory.getRecent('s1', 10), ['summary text']);
  });

  it('falls back to raw text when summarizer fails (best-effort)', async () => {
    const memory = makeFakeMemory();
    const summarizer: IHistorySummarizer = {
      summarize: async () =>
        ({ ok: false, error: { message: 'LLM down' } }) as Result<
          string,
          LlmError
        >,
    };
    const rag = makeFakeRag();

    const turn: HistoryTurn = {
      sessionId: 's1',
      turnIndex: 0,
      userText: 'do something',
      assistantText: 'done it',
      toolCalls: [],
      toolResults: [],
      timestamp: 1000,
    };

    await summarizeAndStore({
      turn,
      summarizer,
      memory,
      rag,
      sessionId: 's1',
    });
    assert.deepEqual(memory.getRecent('s1', 10), ['do something → done it']);
    assert.equal(rag.upserted.length, 1);
    assert.equal(rag.upserted[0].text, 'do something → done it');
  });
});

describe('history-upsert: the record carries its owner (security)', () => {
  const turn: HistoryTurn = {
    sessionId: 's1',
    turnIndex: 7,
    userText: 'show open purchase orders',
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    timestamp: 1000,
  };

  it('tags the history record with sessionId, and userId when the call has one', async () => {
    const rag = makeFakeRag();
    await summarizeAndStore({
      turn,
      summarizer: makeFakeSummarizer('listed open purchase orders'),
      memory: makeFakeMemory(),
      rag,
      sessionId: 's1',
      options: { userId: 'u1' },
    });
    assert.deepEqual(rag.upserted[0].meta, { sessionId: 's1', userId: 'u1' });
  });

  it('a session-scoped history query finds its own turn and not another session’s', async () => {
    // The default pipeline queries `history` with scope: 'session', which
    // every store now filters on metadata.sessionId — an untagged record
    // would be invisible to its own session.
    const rag = new InMemoryRag();
    await summarizeAndStore({
      turn,
      summarizer: makeFakeSummarizer('listed open purchase orders'),
      memory: makeFakeMemory(),
      rag,
      sessionId: 's1',
    });
    const q = { text: 'purchase orders', toVector: async () => [] };
    const own = await rag.query(q, 5, { ragFilter: { sessionId: 's1' } });
    const other = await rag.query(q, 5, { ragFilter: { sessionId: 's2' } });
    assert.ok(own.ok && other.ok);
    assert.equal(own.ok && own.value.length, 1);
    assert.equal(other.ok && other.value.length, 0);
  });
});

describe('history-upsert: HistoryUpsertHandler', () => {
  it('summarizes the turn including the assistant answer', async () => {
    const { HistoryUpsertHandler } = await import('../history-upsert.js');
    const seen: HistoryTurn[] = [];
    const summarizer: IHistorySummarizer = {
      summarize: async (turn) => {
        seen.push(turn);
        return { ok: true, value: 'sum' } as Result<string, LlmError>;
      },
    };
    const ctx = {
      sessionId: 's1',
      inputText: 'the question',
      assistantText: 'the final answer',
      historySummarizer: summarizer,
      historyMemory: makeFakeMemory(),
      config: { semanticHistoryEnabled: true },
      ragStores: { history: makeFakeRag() },
    };
    const span = { setAttribute() {}, setStatus() {} };
    await new HistoryUpsertHandler().execute(ctx as never, {}, span as never);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].userText, 'the question');
    assert.equal(seen[0].assistantText, 'the final answer');
  });
});
