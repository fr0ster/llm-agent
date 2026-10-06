/**
 * Spec §10.5.4 R4, R5, R13 — the rag-query stage fails loud: a store the
 * registry lacks is RAG_STORE_MISSING, a store whose query fails fails the
 * stage with the store's code naming the store. No pipeline embedder stays an
 * absent capability: the store embeds the text itself (R13, kept).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IQueryEmbedding,
  IRag,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  OrchestratorError,
  RagError,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { makeDefaultDeps } from '../../../testing/index.js';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { DefaultPipeline } from '../../default-pipeline.js';
import { RagQueryHandler } from '../rag-query.js';

const span = {
  setAttribute() {},
  setStatus() {},
  addEvent() {},
  end() {},
} as unknown as ISpan;

function store(
  answer: (e: IQueryEmbedding) => Promise<Result<RagResult[], RagError>>,
): IRag & { seen: IQueryEmbedding[] } {
  const seen: IQueryEmbedding[] = [];
  return {
    seen,
    async query(e: IQueryEmbedding) {
      seen.push(e);
      return answer(e);
    },
    async healthCheck() {
      return { ok: true as const, value: undefined };
    },
  } as unknown as IRag & { seen: IQueryEmbedding[] };
}

function ctx(stores: Record<string, IRag>): PipelineContext {
  return {
    ragText: 'q',
    ragStores: stores,
    options: undefined,
    sessionId: 's1',
    config: { ragQueryK: 5 },
    metrics: { ragQueryCount: { add() {} } },
    requestLogger: { logRagQuery() {} },
    ragResults: {},
  } as unknown as PipelineContext;
}

describe('R4 rag-query: a store the registry lacks fails the stage', () => {
  it('RAG_STORE_MISSING naming the store', async () => {
    const c = ctx({});
    const cont = await new RagQueryHandler().execute(
      c,
      { store: 'docs' },
      span,
    );
    assert.equal(cont, false);
    assert.ok(c.error instanceof OrchestratorError);
    assert.equal(c.error.code, 'RAG_STORE_MISSING');
    assert.match(c.error.message, /^rag-query: store "docs" is not registered/);
  });
});

describe('R5 rag-query: a store whose query fails fails the stage', () => {
  it('CIRCUIT_OPEN keeps its code; the message names the store', async () => {
    const s = store(async () => ({
      ok: false,
      error: new RagError('open', 'CIRCUIT_OPEN'),
    }));
    const c = ctx({ docs: s });
    const cont = await new RagQueryHandler().execute(
      c,
      { store: 'docs' },
      span,
    );
    assert.equal(cont, false);
    assert.ok(c.error instanceof OrchestratorError);
    assert.equal(c.error.code, 'CIRCUIT_OPEN');
    assert.match(c.error.message, /^rag-query: store "docs" failed: open/);
    assert.equal(c.ragResults.docs, undefined, 'no partial results');
  });

  it('a successful query with no hits is an honest empty answer', async () => {
    const s = store(async () => ({ ok: true, value: [] }));
    const c = ctx({ docs: s });
    const cont = await new RagQueryHandler().execute(
      c,
      { store: 'docs' },
      span,
    );
    assert.equal(cont, true);
    assert.equal(c.error, undefined);
    assert.deepEqual(c.ragResults.docs, []);
  });
});

describe('R13 rag-query: no pipeline embedder — the store embeds (kept)', () => {
  it('a TextOnlyEmbedding is passed; the store answers as today', async () => {
    const hit: RagResult = { text: 'alpha', metadata: { id: 'a' }, score: 1 };
    const s = store(async () => ({ ok: true, value: [hit] }));
    const c = ctx({ docs: s });
    const cont = await new RagQueryHandler().execute(
      c,
      { store: 'docs' },
      span,
    );
    assert.equal(cont, true);
    assert.ok(s.seen[0] instanceof TextOnlyEmbedding);
    assert.deepEqual(c.ragResults.docs, [hit]);
  });
});

describe('R5 at the consumer: a failing custom store fails the request', () => {
  it('DefaultPipeline + SmartAgent.process → ok:false CIRCUIT_OPEN naming the store', async () => {
    const kb = store(async () => ({
      ok: false,
      error: new RagError('open', 'CIRCUIT_OPEN'),
    }));
    const { deps } = makeDefaultDeps({ ragStores: { kb } });
    const pipeline = new DefaultPipeline();
    pipeline.initialize({
      ...deps,
      agentConfig: { maxIterations: 3 },
    } as never);
    const agent = new SmartAgent({ ...deps, pipeline }, { maxIterations: 3 });
    const r = await agent.process('what is alpha?');
    assert.ok(kb.seen.length > 0, 'the store was asked');
    assert.ok(!r.ok, 'the request answered without the store');
    assert.equal(r.error.code, 'CIRCUIT_OPEN');
    assert.match(r.error.message, /store "kb" failed: open/);
  });
});
