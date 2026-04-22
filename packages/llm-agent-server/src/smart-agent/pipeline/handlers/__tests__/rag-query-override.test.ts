import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IQueryEmbedding,
  IRag,
  RagError,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { RagQueryHandler } from '../rag-query.js';

function makeSpan(): ISpan {
  return {
    setAttribute() {},
    setStatus() {},
    addEvent() {},
    end() {},
  } as unknown as ISpan;
}

function makeStore(capture: { embedding?: IQueryEmbedding }): IRag {
  return {
    async query(embedding, _k, _opts) {
      capture.embedding = embedding;
      return { ok: true, value: [] as RagResult[] } as Result<
        RagResult[],
        RagError
      >;
    },
    async upsert() {
      return { ok: true, value: undefined } as Result<void, RagError>;
    },
    async healthCheck() {
      return { ok: true, value: undefined } as Result<void, RagError>;
    },
  };
}

function makeCtx(partial: Partial<PipelineContext>): PipelineContext {
  return {
    ragText: 'default-rag-text',
    toolQueryText: undefined,
    ragStores: {},
    queryEmbedding: undefined,
    embedder: undefined,
    options: undefined,
    sessionId: 's',
    config: { ragQueryK: 5 } as PipelineContext['config'],
    metrics: {
      ragQueryCount: { add() {} },
    } as unknown as PipelineContext['metrics'],
    requestLogger: {
      logRagQuery() {},
      logLlmCall() {},
    } as unknown as PipelineContext['requestLogger'],
    ragResults: {},
    ...partial,
  } as unknown as PipelineContext;
}

describe('RagQueryHandler queryText override', () => {
  it('uses ctx.toolQueryText when queryText="toolQueryText"', async () => {
    const capture: { embedding?: IQueryEmbedding } = {};
    const ctx = makeCtx({
      ragText: 'user-question',
      toolQueryText: 'enriched-context',
      ragStores: { tools: makeStore(capture) },
    });
    const ok = await new RagQueryHandler().execute(
      ctx,
      { store: 'tools', queryText: 'toolQueryText' },
      makeSpan(),
    );
    assert.equal(ok, true);
    assert.equal(
      (capture.embedding as unknown as { text: string }).text,
      'enriched-context',
    );
  });

  it('does NOT populate ctx.queryEmbedding when queryText override is set', async () => {
    const capture: { embedding?: IQueryEmbedding } = {};
    const ctx = makeCtx({
      ragText: 'user-question',
      toolQueryText: 'enriched-context',
      ragStores: { tools: makeStore(capture) },
    });
    await new RagQueryHandler().execute(
      ctx,
      { store: 'tools', queryText: 'toolQueryText' },
      makeSpan(),
    );
    assert.equal(ctx.queryEmbedding, undefined);
  });

  it('falls back to ragText when toolQueryText is undefined', async () => {
    const capture: { embedding?: IQueryEmbedding } = {};
    const ctx = makeCtx({
      ragText: 'user-question',
      toolQueryText: undefined,
      ragStores: { tools: makeStore(capture) },
    });
    await new RagQueryHandler().execute(
      ctx,
      { store: 'tools', queryText: 'toolQueryText' },
      makeSpan(),
    );
    assert.equal(
      (capture.embedding as unknown as { text: string }).text,
      'user-question',
    );
  });

  it('uses literal queryText string when provided', async () => {
    const capture: { embedding?: IQueryEmbedding } = {};
    const ctx = makeCtx({
      ragText: 'default',
      ragStores: { x: makeStore(capture) },
    });
    await new RagQueryHandler().execute(
      ctx,
      { store: 'x', queryText: 'literal-override' },
      makeSpan(),
    );
    assert.equal(
      (capture.embedding as unknown as { text: string }).text,
      'literal-override',
    );
  });

  it('without queryText caches embedding in ctx.queryEmbedding', async () => {
    const capture: { embedding?: IQueryEmbedding } = {};
    const ctx = makeCtx({
      ragText: 'user-question',
      ragStores: { tools: makeStore(capture) },
    });
    await new RagQueryHandler().execute(ctx, { store: 'tools' }, makeSpan());
    assert.ok(ctx.queryEmbedding);
    assert.equal(
      (ctx.queryEmbedding as unknown as { text: string }).text,
      'user-question',
    );
  });
});
