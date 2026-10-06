/**
 * Spec §10.5.4 R1–R3 (D73): a failing preprocessor, enricher or pipeline
 * embedder is an error — the store never answers with the raw text, and a
 * real embedder that failed is never re-embedded by the store.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IDocumentEnricher,
  type IEmbedder,
  type ILlm,
  type IQueryPreprocessor,
  LlmError,
  QueryEmbedding,
  RagError,
  symmetricEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '../in-memory-rag.js';
import {
  ExpandPreprocessor,
  IntentEnricher,
  TranslatePreprocessor,
} from '../preprocessor.js';
import { VectorRag } from '../vector-rag.js';

const failingPreprocessor: IQueryPreprocessor = {
  name: 'failing',
  async process() {
    return { ok: false, error: new RagError('x', 'QUERY_EXPAND_ERROR') };
  },
};

const failingEnricher: IDocumentEnricher = {
  name: 'failing',
  async enrich() {
    return { ok: false, error: new RagError('x', 'QUERY_EXPAND_ERROR') };
  },
};

function countingEmbedder(): IEmbedder & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async embed() {
      calls++;
      return { vector: [1, 0] };
    },
  };
}

describe('R2 — a store returns its preprocessor / enricher error', () => {
  it('VectorRag.query returns the preprocessor error', async () => {
    const rag = new VectorRag(symmetricEmbedder(countingEmbedder()), {
      queryPreprocessors: [failingPreprocessor],
    });
    const res = await rag.query(new TextOnlyEmbedding('alpha'), 3);
    assert.ok(!res.ok);
    assert.equal(res.error.code, 'QUERY_EXPAND_ERROR');
    assert.equal(res.error.message, 'x');
  });

  it('VectorRag.upsert returns the enricher error', async () => {
    const embedder = countingEmbedder();
    const rag = new VectorRag(symmetricEmbedder(embedder), {
      documentEnrichers: [failingEnricher],
    });
    const res = await rag.upsert('alpha', { id: 'a' });
    assert.ok(!res.ok);
    assert.equal(res.error.code, 'QUERY_EXPAND_ERROR');
    assert.equal(embedder.calls, 0, 'nothing embedded or written');
  });

  it('InMemoryRag.query returns the preprocessor error', async () => {
    const rag = new InMemoryRag({ queryPreprocessors: [failingPreprocessor] });
    const res = await rag.query(new TextOnlyEmbedding('alpha'), 3);
    assert.ok(!res.ok);
    assert.equal(res.error.code, 'QUERY_EXPAND_ERROR');
  });

  it('InMemoryRag.upsert returns the enricher error; nothing is written', async () => {
    const rag = new InMemoryRag({ documentEnrichers: [failingEnricher] });
    const res = await rag.upsert('alpha', { id: 'a' });
    assert.ok(!res.ok);
    assert.equal(res.error.code, 'QUERY_EXPAND_ERROR');
    const q = await rag.query(new TextOnlyEmbedding('alpha'), 3);
    assert.ok(q.ok);
    assert.equal(q.value.length, 0);
  });
});

describe('R1 at the store — a broken pipeline embedder fails the query', () => {
  it('VectorRag.query returns the pipeline embedder error; the store embedder answers no query', async () => {
    const store = countingEmbedder();
    const rag = new VectorRag(symmetricEmbedder(store));
    const w = rag.writer();
    assert.ok(w);
    assert.ok((await w.upsertRaw('a', 'alpha', { id: 'a' })).ok);
    const written = store.calls;
    const broken: IEmbedder = {
      async embed() {
        throw new RagError('down', 'CIRCUIT_OPEN');
      },
    };
    const res = await rag.query(
      new QueryEmbedding('alpha', symmetricEmbedder(broken)),
      3,
    );
    assert.ok(!res.ok);
    assert.equal(res.error.code, 'CIRCUIT_OPEN');
    assert.equal(store.calls, written, 'the store did not re-embed');
  });
});

// An LLM that answers `{ ok: false }`, empty content, or throws.
function llmAnswering(kind: 'error' | 'empty' | 'throw'): ILlm {
  return {
    model: 'test',
    async chat() {
      if (kind === 'throw') throw new Error('socket hang up');
      if (kind === 'error') return { ok: false, error: new LlmError('down') };
      return { ok: true, value: { content: '   ', finishReason: 'stop' } };
    },
    async *streamChat() {
      yield { ok: false, error: new LlmError('not used') };
    },
  } as ILlm;
}

const NON_ASCII = 'внутренние таблицы ABAP запрос';

describe('R3 — preprocessors and the enricher fail with QUERY_EXPAND_ERROR', () => {
  const cases: Array<{
    name: string;
    run: (llm: ILlm) => Promise<{ ok: boolean; error?: RagError }>;
  }> = [
    {
      name: 'TranslatePreprocessor',
      run: (llm) => new TranslatePreprocessor(llm).process(NON_ASCII),
    },
    {
      name: 'ExpandPreprocessor',
      run: (llm) => new ExpandPreprocessor(llm).process('create transport'),
    },
    {
      name: 'IntentEnricher',
      run: (llm) => new IntentEnricher(llm).enrich('GetTable: reads a table'),
    },
  ];
  const expected: Record<'error' | 'empty' | 'throw', RegExp> = {
    error: /down/,
    empty: /empty/,
    throw: /socket hang up/,
  };
  for (const c of cases) {
    for (const kind of ['error', 'empty', 'throw'] as const) {
      it(`${c.name}: an LLM that answers ${kind} → QUERY_EXPAND_ERROR`, async () => {
        const res = await c.run(llmAnswering(kind));
        assert.equal(res.ok, false);
        assert.ok(res.error instanceof RagError);
        assert.equal(res.error.code, 'QUERY_EXPAND_ERROR');
        assert.match(res.error.message, expected[kind]);
        assert.match(res.error.message, new RegExp(`^${c.name}: `));
      });
    }
  }

  it('TranslatePreprocessor: text that needs no translation stays ok: true without an LLM call', async () => {
    let calls = 0;
    const llm = {
      ...llmAnswering('error'),
      async chat() {
        calls++;
        return { ok: false, error: new LlmError('down') };
      },
    } as ILlm;
    const res = await new TranslatePreprocessor(llm).process('ABAP tables');
    assert.ok(res.ok);
    assert.equal(res.value, 'ABAP tables');
    assert.equal(calls, 0);
  });
});
