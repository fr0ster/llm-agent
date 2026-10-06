/**
 * Spec §10.5.6 L1–L4, §13 B6 — a failed helper-LLM call fails the stage with
 * the component's code: no untranslated text, no unexpanded query, no full
 * history, no raw `user → assistant` line stored as a summary.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IHistoryMemory,
  type IHistorySummarizer,
  type ILlm,
  type IQueryExpander,
  type IRag,
  LlmError,
  type LlmResponse,
  type Message,
  RagError,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { makeDefaultDeps } from '../../../testing/index.js';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { DefaultPipeline } from '../../default-pipeline.js';
import { ExpandHandler } from '../expand.js';

const span = {
  setAttribute() {},
  setStatus() {},
  addEvent() {},
  end() {},
} as unknown as ISpan;

function helper(
  answer: () => Result<LlmResponse, LlmError> | Promise<never>,
): ILlm & { calls: number } {
  const h = {
    calls: 0,
    async chat() {
      h.calls++;
      return answer();
    },
    async *streamChat() {
      yield { ok: false as const, error: new LlmError('not used') };
    },
    async healthCheck() {
      return { ok: true as const, value: true };
    },
  };
  return h as unknown as ILlm & { calls: number };
}

const down = () => ({ ok: false as const, error: new LlmError('down') });

const kb = {
  async query() {
    return { ok: true as const, value: [] };
  },
  async healthCheck() {
    return { ok: true as const, value: undefined };
  },
} as unknown as IRag;

/** A DefaultPipeline agent with the given extras on the deps / config. */
function agent(
  extra: Record<string, unknown>,
  config: Record<string, unknown> = {},
  stores: Record<string, IRag> = { kb },
) {
  const { deps } = makeDefaultDeps({ ragStores: stores });
  const full = { ...deps, ...extra };
  const pipeline = new DefaultPipeline();
  pipeline.initialize({
    ...full,
    agentConfig: { maxIterations: 3, ...config },
  } as never);
  return new SmartAgent(
    { ...full, pipeline } as never,
    { maxIterations: 3, ...config } as never,
  );
}

const nonAscii = 'Покажи мені список таблиць, будь ласка';

describe('L1 translate', () => {
  it('a failing helper LLM → the consumer receives LLM_ERROR', async () => {
    const h = helper(down);
    const r = await agent({ helperLlm: h }).process(nonAscii);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'LLM_ERROR');
    assert.match(r.error.message, /translate/);
    assert.equal(h.calls, 1);
  });

  it('an empty answer from a successful call → the same error', async () => {
    const h = helper(() => ({
      ok: true as const,
      value: { content: '   ', finishReason: 'stop' as const },
    }));
    const r = await agent({ helperLlm: h }).process(nonAscii);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'LLM_ERROR');
    assert.match(r.error.message, /translate: empty answer/);
  });

  it('a rejecting helper LLM is the same failure (stage named)', async () => {
    const h = helper(() => Promise.reject(new LlmError('boom', 'LLM_ERROR')));
    const r = await agent({ helperLlm: h }).process(nonAscii);
    assert.ok(!r.ok);
    assert.match(r.error.message, /translate/);
  });
});

describe('L2 expand', () => {
  it('the expander fails → the stage fails with QUERY_EXPAND_ERROR', async () => {
    const expander: IQueryExpander = {
      expand: async () => ({
        ok: false as const,
        error: new RagError('no', 'QUERY_EXPAND_ERROR'),
      }),
    };
    const ctx = {
      ragText: 'original query',
      config: { queryExpansionEnabled: true },
      queryExpander: expander,
      options: undefined,
    } as unknown as PipelineContext;
    const ok = await new ExpandHandler().execute(ctx, {}, span);
    assert.equal(ok, false);
    assert.equal(ctx.error?.code, 'QUERY_EXPAND_ERROR');
    assert.equal(ctx.ragText, 'original query');
  });
});

describe('L3 summarize', () => {
  const history: Message[] = Array.from({ length: 14 }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `m${i}`,
  }));

  it('a failing summarizer → LLM_ERROR, not the full history', async () => {
    const h = helper(down);
    const r = await agent({ helperLlm: h }).process(history);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'LLM_ERROR');
    assert.match(r.error.message, /summarize/);
  });
});

describe('L4 history-upsert', () => {
  const memory = (): IHistoryMemory & { pushed: string[] } => {
    const pushed: string[] = [];
    return {
      pushed,
      pushRecent: (_s: string, x: string) => void pushed.push(x),
      getRecent: () => [],
      clear() {},
    };
  };
  function historyStore(
    upsert: () => Promise<Result<void, RagError>>,
  ): IRag & { upserts: number } {
    const s = {
      upserts: 0,
      async query() {
        return { ok: true as const, value: [] };
      },
      async healthCheck() {
        return { ok: true as const, value: undefined };
      },
      async getById() {
        return { ok: true as const, value: null };
      },
      writer() {
        return {
          upsertRaw: async () => {
            s.upserts++;
            return upsert();
          },
          deleteByIdRaw: async () => ({ ok: true as const, value: false }),
        };
      },
    };
    return s as unknown as IRag & { upserts: number };
  }

  it('the summarizer fails → LLM_ERROR and no raw line in the store', async () => {
    const store = historyStore(async () => ({
      ok: true as const,
      value: undefined,
    }));
    const mem = memory();
    const summarizer: IHistorySummarizer = {
      summarize: async () => ({
        ok: false as const,
        error: new LlmError('down'),
      }),
    };
    const r = await agent(
      { historySummarizer: summarizer, historyMemory: mem },
      { semanticHistoryEnabled: true },
      { history: store },
    ).process('hello there');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'LLM_ERROR');
    assert.equal(store.upserts, 0);
    assert.deepEqual(mem.pushed, []);
  });

  it("the store's upsert fails → its code", async () => {
    const store = historyStore(async () => ({
      ok: false as const,
      error: new RagError('disk full', 'UPSERT_ERROR'),
    }));
    const summarizer: IHistorySummarizer = {
      summarize: async () => ({ ok: true as const, value: 'a summary' }),
    };
    const r = await agent(
      { historySummarizer: summarizer, historyMemory: memory() },
      { semanticHistoryEnabled: true },
      { history: store },
    ).process('hello there');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'UPSERT_ERROR');
    assert.equal(store.upserts, 1);
  });

  it('a rejecting store keeps its typed code', async () => {
    const store = historyStore(() =>
      Promise.reject(new RagError('socket', 'CONNECTION_ERROR')),
    );
    const summarizer: IHistorySummarizer = {
      summarize: async () => ({ ok: true as const, value: 'a summary' }),
    };
    const r = await agent(
      { historySummarizer: summarizer, historyMemory: memory() },
      { semanticHistoryEnabled: true },
      { history: store },
    ).process('hello there');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'CONNECTION_ERROR');
  });
});
