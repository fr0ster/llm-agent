import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm } from '../../interfaces/llm.js';
import {
  LlmError,
  MODEL_CONTEXT_EXCEEDED,
  RagError,
} from '../../interfaces/types.js';
import { makeLlm } from '../../testing/index.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { OverlayRag } from '../overlays/overlay-rag.js';
import {
  ExpandPreprocessor,
  IntentEnricher,
  TranslatePreprocessor,
} from '../preprocessor.js';
import { TextOnlyEmbedding } from '../query-embedding.js';
import { LlmQueryExpander } from '../query-expander.js';
import { IntentToolIndexing } from '../tool-indexing-strategy.js';
import { VectorRag } from '../vector-rag.js';

const text = '¿Dónde están las órdenes de compra?';

function failingLlm(error: LlmError, thrown: boolean) {
  let calls = 0;
  const llm: ILlm = {
    ...makeLlm([]),
    async chat() {
      calls++;
      if (thrown) throw error;
      return { ok: false, error };
    },
  };
  return { llm, calls: () => calls };
}

for (const thrown of [false, true]) {
  const mode = thrown ? 'thrown' : 'returned';
  test(`overlay prefers ${mode} context overflow over an ordinary error`, async () => {
    const model = failingLlm(
      new LlmError('Prompt too long', MODEL_CONTEXT_EXCEEDED),
      thrown,
    );
    const overlay = new InMemoryRag({
      queryPreprocessors: [new ExpandPreprocessor(model.llm)],
    });
    const base = new InMemoryRag();
    const ordinary = new RagError('Unavailable');
    base.query = async () => ({ ok: false, error: ordinary });
    const result = await new OverlayRag(base, overlay).query(
      new TextOnlyEmbedding(text),
      1,
    );
    assert.ok(!result.ok);
    assert.equal(result.error.code, MODEL_CONTEXT_EXCEEDED);
    assert.equal(model.calls(), 1);
  });
  const cases = {
    queryExpansion: (llm: ILlm) => new LlmQueryExpander(llm).expand(text),
    translation: (llm: ILlm) => new TranslatePreprocessor(llm).process(text),
    preprocessing: (llm: ILlm) => new ExpandPreprocessor(llm).process(text),
    enrichment: (llm: ILlm) => new IntentEnricher(llm).enrich(text),
  };
  for (const [name, run] of Object.entries(cases)) {
    test(`${name} preserves ${mode} context overflow and ordinary fallback`, async () => {
      const terminal = Object.assign(new Error('Prompt is too long'), {
        code: MODEL_CONTEXT_EXCEEDED,
      });
      const wrapped = Object.assign(new LlmError('Provider wrapper'), {
        cause: terminal,
      });
      const model = failingLlm(wrapped, thrown);
      const result = await run(model.llm);
      assert.equal(model.calls(), 1);
      assert.ok(!result.ok);
      assert.equal(result.error.code, MODEL_CONTEXT_EXCEEDED);
      assert.equal(result.error.cause, wrapped);

      const ordinary = failingLlm(
        new LlmError('Unavailable', 'CONFIG_ERROR'),
        thrown,
      );
      const fallback = await run(ordinary.llm);
      assert.equal(ordinary.calls(), 1);
      if (name === 'queryExpansion') {
        assert.ok(!fallback.ok);
        assert.equal(fallback.error.code, 'QUERY_EXPAND_ERROR');
      } else {
        assert.deepEqual(fallback, { ok: true, value: text });
      }
    });
  }

  test(`intent indexing preserves ${mode} context overflow and ordinary fallback`, async () => {
    const error = new LlmError('Prompt is too long', MODEL_CONTEXT_EXCEEDED);
    const tool = { name: 'ReadOrders', description: text };
    const model = failingLlm(error, thrown);
    await assert.rejects(
      () => new IntentToolIndexing(model.llm).prepare(tool),
      { code: MODEL_CONTEXT_EXCEEDED },
    );
    assert.equal(model.calls(), 1);

    const ordinary = failingLlm(
      new LlmError('Unavailable', 'CONFIG_ERROR'),
      thrown,
    );
    assert.deepEqual(
      await new IntentToolIndexing(ordinary.llm).prepare(tool),
      [],
    );
    assert.equal(ordinary.calls(), 1);
  });

  for (const store of ['vector', 'memory']) {
    for (const operation of ['query', 'upsert']) {
      test(`${store} ${operation} preserves ${mode} context overflow and ordinary fallback`, async () => {
        let embeddings = 0;
        const embed = async () => {
          embeddings++;
          return { vector: [1] };
        };
        const run = (error: LlmError) => {
          const model = failingLlm(error, thrown);
          const transform = async (input: string) => {
            const result = await model.llm.chat([
              { role: 'user', content: input },
            ]);
            if (!result.ok) {
              const failure = Object.assign(
                new RagError('Transformation failed'),
                { cause: result.error },
              );
              return { ok: false, error: failure };
            }
            return { ok: true, value: result.value.content };
          };
          const config = {
            queryPreprocessors: [{ name: 'expand', process: transform }],
            documentEnrichers: [{ name: 'intent', enrich: transform }],
          };
          const rag =
            store === 'vector'
              ? new VectorRag(
                  { embedQuery: embed, embedDocument: embed },
                  config,
                )
              : new InMemoryRag(config);
          return {
            model,
            result:
              operation === 'query'
                ? rag.query(new TextOnlyEmbedding(text), 2)
                : rag.upsert(text, { id: 'test' }),
          };
        };
        const terminal = run(
          new LlmError('Prompt is too long', MODEL_CONTEXT_EXCEEDED),
        );
        const result = await terminal.result;
        assert.equal(terminal.model.calls(), 1);
        assert.ok(!result.ok);
        assert.equal(result.error.code, MODEL_CONTEXT_EXCEEDED);
        assert.equal(embeddings, 0);

        const ordinary = run(new LlmError('Unavailable', 'CONFIG_ERROR'));
        if (thrown && store === 'memory') {
          await assert.rejects(ordinary.result, /Unavailable/);
        } else {
          const fallback = await ordinary.result;
          assert.equal(fallback.ok, !thrown);
          if (!fallback.ok) {
            assert.equal(
              fallback.error.code,
              operation === 'query' ? 'QUERY_ERROR' : 'UPSERT_ERROR',
            );
          }
        }
        assert.equal(ordinary.model.calls(), 1);
        assert.equal(embeddings, !thrown && store === 'vector' ? 1 : 0);
      });
    }
  }
}
