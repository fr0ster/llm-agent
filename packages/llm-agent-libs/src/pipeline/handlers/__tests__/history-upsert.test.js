import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeAndStore } from '../history-upsert.js';

function makeFakeMemory() {
  const entries = new Map();
  return {
    entries,
    pushRecent(sessionId, summary) {
      if (!entries.has(sessionId)) entries.set(sessionId, []);
      entries.get(sessionId)?.push(summary);
    },
    getRecent(sessionId, limit) {
      return (entries.get(sessionId) ?? []).slice(-limit);
    },
    clear(sessionId) {
      entries.delete(sessionId);
    },
  };
}
function makeFakeSummarizer(response) {
  return {
    summarize: async () => ({ ok: true, value: response }),
  };
}
function makeFakeRag() {
  const upserted = [];
  return {
    upserted,
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
        upsertRaw: async (id, text, meta) => {
          upserted.push({ id, text, meta });
          return { ok: true, value: undefined };
        },
        deleteByIdRaw: async () => ({
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
    const turn = {
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
    const rag = {
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
    const turn = {
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
    const rag = {
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
            ok: false,
            error: { message: 'RAG down' },
          }),
          deleteByIdRaw: async () => ({ ok: true, value: false }),
        };
      },
    };
    const turn = {
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
    const summarizer = {
      summarize: async () => ({ ok: false, error: { message: 'LLM down' } }),
    };
    const rag = makeFakeRag();
    const turn = {
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
//# sourceMappingURL=history-upsert.test.js.map
