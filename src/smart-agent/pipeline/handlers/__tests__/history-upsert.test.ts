import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IHistoryMemory } from '../../../interfaces/history-memory.js';
import type {
  HistoryTurn,
  IHistorySummarizer,
} from '../../../interfaces/history-summarizer.js';
import type { LlmError, Result } from '../../../interfaces/types.js';

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

function makeFakeRag(): { upserted: Array<{ text: string; meta: unknown }> } & {
  upsert: (
    text: string,
    meta: unknown,
  ) => Promise<Result<void, { message: string }>>;
} {
  const upserted: Array<{ text: string; meta: unknown }> = [];
  return {
    upserted,
    upsert: async (text: string, meta: unknown) => {
      upserted.push({ text, meta });
      return { ok: true, value: undefined };
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
      rag: rag as never,
      sessionId: 's1',
    });

    assert.equal(rag.upserted.length, 1);
    assert.equal(rag.upserted[0].text, 'Created class ZCL_TEST in ZDEV');
    assert.deepEqual(memory.getRecent('s1', 10), [
      'Created class ZCL_TEST in ZDEV',
    ]);
  });

  it('still pushes to memory when RAG upsert fails (best-effort)', async () => {
    const memory = makeFakeMemory();
    const summarizer = makeFakeSummarizer('summary text');
    const rag = {
      upsert: async () => ({ ok: false, error: { message: 'RAG down' } }),
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
      rag: rag as never,
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
      rag: rag as never,
      sessionId: 's1',
    });
    assert.deepEqual(memory.getRecent('s1', 10), ['do something → done it']);
    assert.equal(rag.upserted.length, 1);
    assert.equal(rag.upserted[0].text, 'do something → done it');
  });
});
