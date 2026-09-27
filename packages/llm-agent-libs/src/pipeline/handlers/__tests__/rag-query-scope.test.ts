import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  IRag,
  RagError,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { RagQueryHandler } from '../rag-query.js';

const span = {
  setAttribute() {},
  setStatus() {},
  addEvent() {},
  end() {},
} as unknown as ISpan;

function store(seen: { calls: CallOptions[] }): IRag {
  return {
    async query(_e, _k, opts) {
      seen.calls.push(opts ?? {});
      return {
        ok: true,
        value: [{ text: 'someone', metadata: { userId: 'bob' }, score: 1 }],
      } as Result<RagResult[], RagError>;
    },
    async healthCheck() {
      return { ok: true, value: undefined } as Result<void, RagError>;
    },
  } as unknown as IRag;
}

function ctx(rag: IRag, userId?: string): PipelineContext {
  return {
    ragText: 'q',
    ragStores: { mem: rag },
    options: userId ? { userId } : undefined,
    sessionId: 's1',
    config: { ragQueryK: 5 },
    metrics: { ragQueryCount: { add() {} } },
    requestLogger: { logRagQuery() {} },
    ragResults: {},
  } as unknown as PipelineContext;
}

describe('RagQueryHandler scope: user', () => {
  it('filters by the caller userId when there is one', async () => {
    const seen = { calls: [] as CallOptions[] };
    await new RagQueryHandler().execute(
      ctx(store(seen), 'alice'),
      { store: 'mem', scope: 'user' },
      span,
    );
    assert.equal(seen.calls[0].ragFilter?.userId, 'alice');
  });

  it('with no userId returns nothing and never asks the store — not everyone', async () => {
    // An unfiltered query here returned every user's records.
    const seen = { calls: [] as CallOptions[] };
    const c = ctx(store(seen));
    const cont = await new RagQueryHandler().execute(
      c,
      { store: 'mem', scope: 'user' },
      span,
    );
    assert.equal(cont, true);
    assert.equal(seen.calls.length, 0);
    assert.deepEqual(c.ragResults.mem, []);
  });
});
