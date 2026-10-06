/**
 * Spec §17.43 D97 (D72 extended): a reranker the built agent uses counts
 * toward `/health`. The agent probes the global reranker and every reranker a
 * store's retrieval strategy holds; a reranker wired into nothing is not
 * probed. `healthCheck` when present, else one minimal `rerank` call; under
 * the health signal like the other probes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  IRag,
  IReranker,
  RagResult,
} from '@mcp-abap-adt/llm-agent';
import { RagError } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../agent.js';
import { StagedRetrieval } from '../../collections/staged-retrieval.js';
import {
  RerankAllRetrieval,
  RerankedRetrieval,
} from '../../retrieval/reranked-retrieval.js';
import { StrategyRag } from '../../retrieval/strategy-rag.js';
import { makeDefaultDeps, makeRag } from '../../testing/index.js';
import { HealthChecker } from '../health-checker.js';

const CONFIG = { maxIterations: 5 };

interface Probed extends IReranker {
  rerankCalls: Array<{ query: string; results: RagResult[] }>;
  healthCalls: number;
}

function reranker(
  health?: IReranker['healthCheck'],
  rerank?: IReranker['rerank'],
): Probed {
  const r: Probed = {
    rerankCalls: [],
    healthCalls: 0,
    async rerank(query, results, options) {
      r.rerankCalls.push({ query, results });
      return rerank
        ? rerank(query, results, options)
        : { ok: true, value: results };
    },
  };
  if (health) {
    r.healthCheck = async (options?: CallOptions) => {
      r.healthCalls++;
      return health(options);
    };
  }
  return r;
}

function staged(r: IReranker): StagedRetrieval {
  return new StagedRetrieval({
    name: 'staged',
    storeKey: 'tools',
    maxRecordsPerItem: 1,
    canonicalKind: 'canonical',
    sources: { select: () => [] } as never,
    collapse: {} as never,
    rerank: { reranker: r },
  });
}

function agentWith(opts: {
  reranker?: IReranker;
  ragStores?: Record<string, IRag>;
  healthTimeoutMs?: number;
}): SmartAgent {
  const { deps } = makeDefaultDeps({
    ...(opts.reranker ? { reranker: opts.reranker } : {}),
    ...(opts.ragStores ? { ragStores: opts.ragStores } : {}),
  });
  return new SmartAgent(deps, {
    ...CONFIG,
    ...(opts.healthTimeoutMs ? { healthTimeoutMs: opts.healthTimeoutMs } : {}),
  });
}

describe('agent health — rerankers (D97)', () => {
  it('a global reranker whose healthCheck answers ok:false → not OK, named', async () => {
    const r = reranker(async () => ({
      ok: false,
      error: new RagError('cohere deployment down', 'RERANK_ERROR'),
    }));
    const res = await agentWith({ reranker: r }).healthCheck();
    assert.ok(res.ok);
    assert.deepEqual(res.value.reranker, [
      { name: 'global', ok: false, error: 'cohere deployment down' },
    ]);
    assert.equal(r.rerankCalls.length, 0, 'healthCheck present → no rerank');
  });

  it('a healthCheck answering false → not OK', async () => {
    const r = reranker(async () => ({ ok: true, value: false }));
    const res = await agentWith({ reranker: r }).healthCheck();
    assert.ok(res.ok);
    assert.deepEqual(res.value.reranker, [
      { name: 'global', ok: false, error: 'unhealthy' },
    ]);
  });

  it('a healthCheck that throws → not OK, with the error', async () => {
    const r = reranker(async () => {
      throw new Error('probe exploded');
    });
    const res = await agentWith({ reranker: r }).healthCheck();
    assert.ok(res.ok);
    assert.deepEqual(res.value.reranker, [
      { name: 'global', ok: false, error: 'probe exploded' },
    ]);
  });

  it('a reranker held only by a store’s StagedRetrieval is probed', async () => {
    const r = reranker(async () => ({ ok: true, value: true }));
    const store = new StrategyRag(makeRag(), staged(r));
    const res = await agentWith({ ragStores: { tools: store } }).healthCheck();
    assert.ok(res.ok);
    assert.equal(r.healthCalls, 1);
    assert.deepEqual(res.value.reranker, [{ name: 'store:tools', ok: true }]);
  });

  it('rerankers held by RerankedRetrieval and RerankAllRetrieval are probed', async () => {
    const a = reranker(async () => ({ ok: true, value: true }));
    const b = reranker(async () => ({ ok: true, value: true }));
    const res = await agentWith({
      ragStores: {
        facts: new StrategyRag(makeRag(), new RerankedRetrieval(a)),
        docs: new StrategyRag(
          makeRag(),
          new RerankAllRetrieval(b, { maxCandidates: 5 }),
        ),
      },
    }).healthCheck();
    assert.ok(res.ok);
    assert.equal(a.healthCalls, 1);
    assert.equal(b.healthCalls, 1);
    assert.deepEqual(res.value.reranker?.map((x) => x.name).sort(), [
      'store:docs',
      'store:facts',
    ]);
  });

  it('one reranker held twice is probed once, both holders named', async () => {
    const r = reranker(async () => ({ ok: true, value: true }));
    const res = await agentWith({
      reranker: r,
      ragStores: {
        tools: new StrategyRag(makeRag(), new RerankedRetrieval(r)),
      },
    }).healthCheck();
    assert.ok(res.ok);
    assert.equal(r.healthCalls, 1);
    assert.deepEqual(res.value.reranker, [
      { name: 'global, store:tools', ok: true },
    ]);
  });

  it('a reranker without healthCheck: one minimal rerank call; its failure → not OK', async () => {
    const r = reranker(undefined, async () => ({
      ok: false,
      error: new RagError('model gone', 'RERANK_ERROR'),
    }));
    const res = await agentWith({ reranker: r }).healthCheck();
    assert.ok(res.ok);
    assert.equal(r.rerankCalls.length, 1, 'exactly one minimal call');
    assert.equal(r.rerankCalls[0].results.length, 1, 'over one candidate');
    assert.deepEqual(res.value.reranker, [
      { name: 'global', ok: false, error: 'model gone' },
    ]);
  });

  it('a reranker without healthCheck that answers → OK', async () => {
    const r = reranker();
    const res = await agentWith({ reranker: r }).healthCheck();
    assert.ok(res.ok);
    assert.equal(r.rerankCalls.length, 1);
    assert.deepEqual(res.value.reranker, [{ name: 'global', ok: true }]);
  });

  it('a reranker wired into nothing is not probed; no reranker → no field', async () => {
    const unused = reranker(async () => ({ ok: true, value: true }));
    const res = await agentWith({}).healthCheck();
    assert.ok(res.ok);
    assert.equal(unused.healthCalls, 0);
    assert.equal(unused.rerankCalls.length, 0);
    assert.equal('reranker' in res.value, false, 'no reranker → no field');
  });

  it('a healthCheck that never answers → not OK under the health signal, no unhandled rejection', {
    timeout: 5_000,
  }, async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const r = reranker(() => new Promise(() => {}));
      const res = await agentWith({
        reranker: r,
        healthTimeoutMs: 30,
      }).healthCheck();
      assert.ok(res.ok);
      assert.equal(res.value.reranker?.[0].ok, false);
      assert.match(
        res.value.reranker?.[0].error ?? '',
        /timed out|timeout|abort/i,
      );
      await new Promise((r2) => setTimeout(r2, 20));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('HealthChecker: a reranker not OK → degraded (the route answers 503)', async () => {
    const r = reranker(async () => ({ ok: true, value: false }));
    const status = await new HealthChecker({
      agent: agentWith({ reranker: r }),
      startTime: Date.now(),
      version: 't',
    }).check();
    assert.equal(status.status, 'degraded');
    assert.deepEqual(status.components.reranker, [
      { name: 'global', ok: false, error: 'unhealthy' },
    ]);
  });

  it('HealthChecker: a working reranker keeps healthy', async () => {
    const r = reranker(async () => ({ ok: true, value: true }));
    const status = await new HealthChecker({
      agent: agentWith({ reranker: r }),
      startTime: Date.now(),
      version: 't',
    }).check();
    assert.equal(status.status, 'healthy');
  });
});
