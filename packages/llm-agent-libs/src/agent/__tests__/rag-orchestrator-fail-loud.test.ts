/** Spec §10.5.6 L1–L3 — the legacy orchestrator (no pipeline) fails loud. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ILlm,
  type IQueryExpander,
  type IRag,
  LlmError,
  type Message,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../agent.js';
import { makeClassifier, makeDefaultDeps } from '../../testing/index.js';

const kb = {
  async query() {
    return { ok: true as const, value: [] };
  },
  async healthCheck() {
    return { ok: true as const, value: undefined };
  },
} as unknown as IRag;

const failingHelper = {
  async chat() {
    return { ok: false as const, error: new LlmError('down') };
  },
  async *streamChat() {
    yield { ok: false as const, error: new LlmError('down') };
  },
  async healthCheck() {
    return { ok: true as const, value: true };
  },
} as unknown as ILlm;

const history: Message[] = Array.from({ length: 14 }, (_, i) => ({
  role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
  content: `m${i}`,
}));

describe('legacy RagOrchestrator fails loud', () => {
  it('a failing summarizer → process() returns LLM_ERROR', async () => {
    const { deps } = makeDefaultDeps({ ragStores: { kb } });
    const r = await new SmartAgent(
      { ...deps, helperLlm: failingHelper },
      { maxIterations: 3 },
    ).process(history);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'LLM_ERROR');
    assert.match(r.error.message, /summarize/);
  });

  it('a failing translation → process() returns LLM_ERROR', async () => {
    const text = 'Покажи мені список таблиць, будь ласка';
    const { deps } = makeDefaultDeps({
      ragStores: { kb },
      classifier: makeClassifier([{ type: 'action', text }]),
    });
    const r = await new SmartAgent(
      {
        ...deps,
        helperLlm: failingHelper,
        translateQueryStores: new Set(['kb']),
      },
      { maxIterations: 3 },
    ).process(text);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'LLM_ERROR');
  });

  it('a failing expander → process() returns QUERY_EXPAND_ERROR', async () => {
    const expander: IQueryExpander = {
      expand: async () => ({
        ok: false as const,
        error: new RagError('no', 'QUERY_EXPAND_ERROR'),
      }),
    };
    const { deps } = makeDefaultDeps({ ragStores: { kb } });
    const r = await new SmartAgent(
      {
        ...deps,
        queryExpander: expander,
        translateQueryStores: new Set(['kb']),
      },
      { maxIterations: 3, queryExpansionEnabled: true },
    ).process('show tables');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'QUERY_EXPAND_ERROR');
  });
});
