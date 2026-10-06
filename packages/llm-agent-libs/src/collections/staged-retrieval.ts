// packages/llm-agent-libs/src/collections/staged-retrieval.ts
/**
 * The composable retrieval half of a collection profile (spec §4): candidates
 * counted in ITEMS → collapse records back to owner-qualified items → optional
 * reranker on the item's provider text → hydrate every returned item from its
 * CANONICAL record (owner-checked; no canonical → orphan, dropped) → one cut.
 *
 * It queries the sources its profile bound (`ISourceSelector`), not the `store`
 * argument of `retrieve` — that is the inner store `StrategyRag` passes.
 */
import {
  type CallOptions,
  type ICandidatePool,
  type ICollapseRule,
  type IItemCut,
  type IQueryDecomposer,
  type IQueryEmbedder,
  type IQueryEmbedding,
  type IRag,
  type IReranker,
  type IRetrievalMetrics,
  type IRetrievalStrategy,
  type ISourceSelector,
  type ITracer,
  matchesRagIdentity,
  QueryEmbedding,
  RagError,
  type RagResult,
  type Result,
  type RetrievalSource,
  ragIdentityFilter,
  recordId,
  type SourcedHit,
  type SubQuery,
} from '@mcp-abap-adt/llm-agent';
import {
  callReranker,
  MAX_THROWN_MESSAGE,
  rerankFailedError,
} from '../retrieval/rerank-call.js';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';
import { ScoreFloorCut, TopItemsCut } from './cuts.js';
import { ItemPool } from './item-pool.js';
import { itemKey, ownerFromMetadata } from './owner.js';
import { asItem, isExpired } from './record-writer.js';
import { checkRerankOutput } from './rerank-check.js';
import { toRagError } from './to-rag-error.js';

export interface StagedRetrievalOptions {
  /** Reported as `strategy`. */
  name: string;
  /** Reported as `store`. */
  storeKey: string;
  /** Candidate strategy, counted in ITEMS. Absent → `ItemPool()`: the caller's k
   *  items of each (sub-)query — the generic default (D56, spec §4.2). */
  pool?: ICandidatePool;
  /** From the indexing strategy, not set by the consumer. */
  maxRecordsPerItem: number;
  /** From the indexing strategy; locates the canonical record. */
  canonicalKind: string;
  /** From the profile's bind(). */
  sources: ISourceSelector;
  collapse: ICollapseRule;
  rerank?: {
    reranker: IReranker;
    /** Default 0; counted inside k (spec §4.7). No `onFailure`: a failed rerank returns RERANK_ERROR (D71). */
    keepStage1Top?: number;
  };
  /** Absent → the query runs as is (one run). */
  decompose?: { decomposer: IQueryDecomposer; queryEmbedder: IQueryEmbedder };
  /** Absent → TopItemsCut (caller's k). */
  cut?: IItemCut;
  telemetry?: { tracer?: ITracer; metrics?: IRetrievalMetrics };
}

/** One unit stage 1 hands on: a collapsed item, or a record without itemId passed through. */
export interface Unit {
  readonly key: string;
  readonly score: number;
  /** The source the unit belongs to (every source holds items, D50). */
  readonly source: RetrievalSource;
  readonly hits: readonly RagResult[];
  /** Set for a collapsed item; absent for a pass-through record. */
  readonly item?: { readonly itemId: string; readonly canonicalId: string };
  /** Set by the reranker (Task 13) on a `keepStage1Top` pin: it keeps its head place. */
  readonly pinned?: boolean;
}

/** A hydrated item with the unit it came from: its scale and its pin travel with it. */
export interface Hydrated {
  readonly unit: Unit;
  readonly item: RagResult;
}

/** What one run observed; emitted as telemetry (Task 28). */
export interface RunStats {
  sources: string[];
  candidateRecords: number;
  collapsedItems: number;
  orphans: number;
  hydrationReads: number;
  rerankOutcome: 'none' | 'ok' | 'error';
  rerankError?: string;
}

export interface RunContext {
  readonly stats: RunStats;
  /** Canonical record per unit key; null = orphan. */
  readonly canonicals: Map<string, RagResult | null>;
  readonly options?: CallOptions;
}

export function newRunContext(options?: CallOptions): RunContext {
  return {
    stats: {
      sources: [],
      candidateRecords: 0,
      collapsedItems: 0,
      orphans: 0,
      hydrationReads: 0,
      rerankOutcome: 'none',
    },
    canonicals: new Map(),
    ...(options ? { options } : {}),
  };
}

const OUTCOME_SEVERITY: Record<RunStats['rerankOutcome'], number> = {
  none: 0,
  ok: 1,
  error: 2,
};
/** Keep the run's most severe rerank outcome across its `rank` calls. */
function recordOutcome(
  ctx: RunContext,
  outcome: RunStats['rerankOutcome'],
): void {
  if (OUTCOME_SEVERITY[outcome] > OUTCOME_SEVERITY[ctx.stats.rerankOutcome])
    ctx.stats.rerankOutcome = outcome;
}

/** The first `n` units per source (the pool) and the rest of what was fetched (the overflow), both in stage-1 order. */
function splitPerSource(
  units: readonly Unit[],
  n: number,
): { pooled: Unit[]; overflow: Unit[] } {
  const count = new Map<string, number>();
  const pooled: Unit[] = [];
  const overflow: Unit[] = [];
  for (const u of units) {
    const c = count.get(u.source.name) ?? 0;
    if (c >= n) {
      overflow.push(u);
      continue;
    }
    count.set(u.source.name, c + 1);
    pooled.push(u);
  }
  return { pooled, overflow };
}

/**
 * Spec §4.6 (D67): the pool's hydrated items and the orphans' replacements as ONE
 * list by DESCENDING score — appended, a replacement that outscores a surviving
 * item would sit below it, and a ScoreFloorCut (it stops at the first score below
 * its floor) would drop it. Every score is against the same query, so one scale
 * (D28): reranked, or stage-1 without a reranker — a failed rerank fails the whole
 * retrieval (D71), so two scales never meet here. `keepStage1Top` pins keep their
 * head places. The sort is stable: ties keep order.
 */
function mergeByScore(got: readonly Hydrated[]): Hydrated[] {
  const head = got.filter((h) => h.unit.pinned === true);
  const rest = got.filter((h) => h.unit.pinned !== true);
  rest.sort((a, b) => b.item.score - a.item.score);
  return [...head, ...rest];
}

/** A Result-returning store call, handled on both failure paths (`ok: false` and a rejection). */
async function settled<T>(
  call: () => Promise<Result<T, RagError>>,
): Promise<Result<T, RagError>> {
  try {
    return await call();
  } catch (err) {
    return { ok: false, error: toRagError(err) };
  }
}

const decomposeError = (message: string): Result<never, RagError> => ({
  ok: false,
  error: new RagError(message, 'DECOMPOSE_ERROR'),
});

const matchedKinds = (hits: readonly RagResult[]): string[] => [
  ...new Set(hits.map((h) => String(h.metadata.recordKind))),
];

export class StagedRetrieval implements IRetrievalStrategy {
  readonly name: string;
  protected readonly cut: IItemCut;
  protected readonly pool: ICandidatePool;

  constructor(readonly options: StagedRetrievalOptions) {
    assertPositiveInteger(
      'StagedRetrieval',
      'maxRecordsPerItem',
      options.maxRecordsPerItem,
    );
    const keep = options.rerank?.keepStage1Top;
    if (keep !== undefined && (!Number.isInteger(keep) || keep < 0)) {
      throw new Error(
        `StagedRetrieval: keepStage1Top must be a non-negative integer (got ${keep})`,
      );
    }
    this.name = options.name;
    this.cut = options.cut ?? new TopItemsCut();
    this.pool = options.pool ?? new ItemPool();
    // Spec §4.7 (F5): pinned items are unmeasured (D7) — a threshold calibrated on
    // reranked scores must not see them. A failed rerank is an error (D71), so no
    // stage-1 score ever reaches the cut under a reranker.
    const rr = options.rerank;
    if (
      rr &&
      this.cut instanceof ScoreFloorCut &&
      (rr.keepStage1Top ?? 0) > 0
    ) {
      throw new Error(
        'StagedRetrieval: keepStage1Top cannot be combined with ScoreFloorCut — keepStage1Top is unmeasured (D7); a threshold over a pinned head would let an unmeasured order decide what a calibrated threshold keeps',
      );
    }
    // Spec §4.5 (D63): scores of different sub-queries are not comparable (§3.9,
    // D28); a threshold over the merged union would compare them.
    if (options.decompose && this.cut instanceof ScoreFloorCut) {
      throw new Error(
        'StagedRetrieval: a decomposer cannot be combined with ScoreFloorCut — scores of different sub-queries are not comparable (§4.5, D63); a threshold over the merged union would compare them',
      );
    }
  }

  async retrieve(
    _store: IRag,
    query: IQueryEmbedding,
    k: number,
    callOptions?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    // The caller's k caps every cut, also after decomposition (spec §4.5, F1).
    const budget = Math.min(k, this.cut.limit(k));
    const finish = (items: RagResult[]): Result<RagResult[], RagError> => ({
      ok: true,
      value: this.cut.cut(items, k).slice(0, budget),
    });
    const d = this.options.decompose;
    let subs: readonly SubQuery[] = [];
    if (d) {
      const decomposed = await this.decomposeQuery(
        d.decomposer,
        query.text,
        budget,
        callOptions,
      );
      if (!decomposed.ok) return decomposed;
      subs = decomposed.value;
    }
    if (!d || subs.length === 0) {
      const run = await this.runOne(
        query,
        budget,
        newRunContext(callOptions),
        k,
      );
      return run.ok ? finish(run.value.map((h) => h.item)) : run;
    }
    const runs = await Promise.all(
      subs.map((s) =>
        this.runOne(
          new QueryEmbedding(s.text, d.queryEmbedder, callOptions),
          s.k,
          newRunContext(callOptions),
          s.k, // each sub-query's pool is sized from its own k (D56)
        ),
      ),
    );
    // Union in sub-query order (spec §4.5, D63): each sub-query's own ranked list, one
    // after the other; a duplicate item stays at its FIRST occurrence with that
    // occurrence's score. Scores of different sub-queries are never compared.
    // "Same" is the stage-1 unit key, which qualifies the source and the owner:
    // `itemKey(source, owner, itemId)` for an item, `['record', source, id]` for a
    // pass-through record — so two sources' records sharing an id stay two.
    const union: RagResult[] = [];
    const seen = new Set<string>();
    for (const run of runs) {
      if (!run.ok) return run;
      for (const { unit, item } of run.value) {
        if (seen.has(unit.key)) continue;
        seen.add(unit.key);
        union.push(item);
      }
    }
    return finish(union);
  }

  /** Calls the consumer's decomposer and checks its answer (spec §4.5). Never swallowed. */
  private async decomposeQuery(
    decomposer: IQueryDecomposer,
    text: string,
    budget: number,
    callOptions?: CallOptions,
  ): Promise<Result<readonly SubQuery[], RagError>> {
    let r: Result<readonly SubQuery[], RagError>;
    try {
      r = await decomposer.decompose(text, budget, callOptions);
    } catch (err) {
      return decomposeError(
        `decomposer ${decomposer.name} threw: ${String(err).slice(0, MAX_THROWN_MESSAGE)}`,
      );
    }
    if (!r.ok) {
      // The decomposer's own code travels in the message (as a rerank failure's, Task 13).
      return decomposeError(
        `decomposer ${decomposer.name} failed: ${r.error.code}: ${r.error.message}`,
      );
    }
    let sum = 0;
    for (const s of r.value) {
      if (!Number.isInteger(s.k) || s.k < 1) {
        return decomposeError(
          `sub-query k must be an integer ≥ 1 (got ${s.k})`,
        );
      }
      if (typeof s.text !== 'string' || s.text.trim().length === 0) {
        return decomposeError('sub-query text must be non-empty');
      }
      sum += s.k;
    }
    if (sum > budget) {
      return decomposeError(
        `sub-query budgets sum to ${sum}, above the retrieval's budget ${budget}`,
      );
    }
    return r;
  }

  /** §4.3 up to hydration: at most `keep` hydrated items, in rank order, each with
   *  the stage-1 unit it came from (the sub-query union keys on `unit.key`). `poolK`
   *  is the k of this (sub-)query, which the pool is sized from (D56). */
  protected async runOne(
    query: IQueryEmbedding,
    keep: number,
    ctx: RunContext,
    poolK: number,
  ): Promise<Result<Hydrated[], RagError>> {
    const o = this.options;
    const sources = await o.sources.sources(ctx.options);
    const byName = new Map(sources.map((s) => [s.name, s] as const));
    ctx.stats.sources = sources.map((s) => s.name);
    // A hit belongs to the source it came from, by name (D50): two sources with
    // one name would merge their items and hydrate them from the wrong store.
    if (byName.size !== sources.length) {
      const dup = sources.find(
        (s, i) => sources.findIndex((t) => t.name === s.name) !== i,
      );
      return {
        ok: false,
        error: new RagError(
          `${o.name}: two retrieval sources are named "${dup?.name}"; source names must be unique`,
        ),
      };
    }
    const fetch = this.pool.recordsToFetch(poolK, o.maxRecordsPerItem);
    const answers = await Promise.all(
      sources.map((s) => settled(() => s.rag.query(query, fetch, s.options))),
    );
    const hits: SourcedHit[] = [];
    const units: Unit[] = [];
    for (const [i, answer] of answers.entries()) {
      if (!answer.ok) return answer;
      const s = sources[i];
      ctx.stats.candidateRecords += answer.value.length;
      for (const h of answer.value) {
        if (typeof h.metadata.itemId !== 'string') {
          units.push({
            key: JSON.stringify(['record', s.name, String(h.metadata.id)]),
            score: h.score,
            source: s,
            hits: [h],
          });
          continue;
        }
        if (!ownerFromMetadata(h.metadata)) {
          ctx.stats.orphans++;
          continue;
        }
        hits.push({ ...h, source: s.name });
      }
    }
    const collapsed = o.collapse.collapse(hits);
    ctx.stats.collapsedItems = collapsed.length;
    for (const c of collapsed) {
      const source = byName.get(c.source);
      if (!source) {
        return {
          ok: false,
          error: new RagError(
            `${o.name}: collapse rule "${o.collapse.name}" returned an item of source "${c.source}", which was not queried`,
          ),
        };
      }
      units.push({
        key: itemKey(c.source, c.owner, c.itemId),
        score: c.score,
        source,
        hits: c.hits,
        item: {
          itemId: c.itemId,
          canonicalId: recordId(c.owner, c.itemId, o.canonicalKind, 0),
        },
      });
    }
    // Ties break on the unit key — deterministic, and the same for an item and a
    // pass-through record (never by unit kind or the order units were built in).
    units.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    // The pool is the first pool.items(k) units per source; the rest of what
    // was fetched is KEPT, in stage-1 order (spec §4.4, §4.6, D67).
    const { pooled, overflow } = splitPerSource(units, this.pool.items(poolK));
    const ranked = await this.rank(pooled, query.text, ctx, true);
    if (!ranked.ok) return ranked;
    const first = await this.hydrate(ranked.value, keep, ctx);
    if (!first.ok) return first;
    const got = first.value;
    // Orphans never use up the pool, so they never use up k (spec §4.6, D67):
    // each orphan of the pool is replaced by the next fetched unit, in stage-1
    // order — ranked like the pool (a reranker scores it against the same
    // query, D28; no keepStage1Top pins: those are the pool's stage-1 places)
    // and hydrated — until `keep` items or the overflow is spent. No new query.
    let next = 0;
    while (got.length < keep && next < overflow.length) {
      const batch = overflow.slice(next, next + keep - got.length);
      next += batch.length;
      const rankedMore = await this.rank(batch, query.text, ctx, false);
      if (!rankedMore.ok) return rankedMore;
      const more = await this.hydrate(rankedMore.value, keep - got.length, ctx);
      if (!more.ok) return more;
      got.push(...more.value);
    }
    // Merged by descending score, never appended (spec §4.6, D67).
    return { ok: true, value: mergeByScore(got) };
  }

  /**
   * The reranker reads the ITEM text (spec §4.6): a canonical hit's text, else a
   * non-canonical hit's `itemText` shortcut, else the canonical record (read
   * now). Undefined = orphan (dropped before reranking).
   */
  private async itemText(
    u: Unit,
    ctx: RunContext,
  ): Promise<Result<string | undefined, RagError>> {
    if (!u.item) return { ok: true, value: u.hits[0]?.text };
    const canonicalHit = u.hits.find(
      (h) => h.metadata.recordKind === this.options.canonicalKind,
    );
    if (canonicalHit) return { ok: true, value: canonicalHit.text };
    const shortcut = u.hits.find(
      (h) => typeof h.metadata.itemText === 'string',
    );
    if (shortcut)
      return { ok: true, value: String(shortcut.metadata.itemText) };
    const c = await this.canonicalOf(u, ctx);
    if (!c.ok) return c;
    return { ok: true, value: c.value?.text };
  }

  /**
   * What the reranker sees of a unit besides its text: the canonical hit's
   * metadata, else only `{ id, itemId }` — never a non-canonical record's own
   * metadata (its kind or `itemText`). A pass-through record is its own record.
   * `id` is always the unit key: the output check and the mapping back use it.
   */
  private candidateMetadata(u: Unit): RagResult['metadata'] {
    if (!u.item) return { ...(u.hits[0]?.metadata ?? {}), id: u.key };
    const canonicalHit = u.hits.find(
      (h) => h.metadata.recordKind === this.options.canonicalKind,
    );
    if (canonicalHit) return { ...canonicalHit.metadata, id: u.key };
    return { id: u.key, itemId: u.item.itemId };
  }

  protected async rank(
    pooled: Unit[],
    text: string,
    ctx: RunContext,
    pin: boolean,
  ): Promise<Result<Unit[], RagError>> {
    const rr = this.options.rerank;
    if (!rr || pooled.length === 0) return { ok: true, value: pooled };
    // `IRag` has no batch get: the item-text reads (a canonical read per unit
    // that needs one) run in parallel (spec §4.6); `canonicalOf` caches by unit
    // key in `ctx`, so no read or orphan is counted twice. Pool order is kept.
    const texts = await Promise.all(pooled.map((u) => this.itemText(u, ctx)));
    const live: Unit[] = [];
    const candidates: RagResult[] = [];
    for (const [i, u] of pooled.entries()) {
      const t = texts[i];
      if (!t.ok) return t;
      if (t.value === undefined) continue;
      live.push(u);
      candidates.push({
        text: t.value,
        metadata: this.candidateMetadata(u),
        score: u.score,
      });
    }
    // Task 4I's shared path: a reranker `ok: false`, a throw (`RERANK_THROWN`,
    // capped) or an output that fails the check (`RERANK_ERROR`) → one failure.
    const r = await callReranker(
      rr.reranker,
      text,
      candidates,
      ctx.options,
      (out) => checkRerankOutput(candidates, out),
    );
    if (!r.ok) {
      const failure = r.failure;
      ctx.options?.sessionLogger?.logStep('retrieval_rerank_error', {
        store: this.options.storeKey,
        strategy: this.name,
        code: failure.code,
        message: failure.message,
      });
      ctx.stats.rerankError = `${failure.code}: ${failure.message}`;
      // One behaviour (spec §9.3, D71): no stage-1 fallback.
      recordOutcome(ctx, 'error');
      return { ok: false, error: rerankFailedError(failure) };
    }
    const out = r.value;
    recordOutcome(ctx, 'ok');
    const byKey = new Map(live.map((u) => [u.key, u] as const));
    const reranked: Unit[] = [];
    for (const r of out) {
      const u = byKey.get(String(r.metadata.id));
      if (u) reranked.push({ ...u, score: r.score });
    }
    // Pins are the POOL's stage-1 places; the replacements of orphans (Task 12,
    // `pin` false) are reranked without them (spec §4.6, §4.7, D67).
    const keepTop = pin ? (rr.keepStage1Top ?? 0) : 0;
    if (keepTop === 0) return { ok: true, value: reranked };
    // Pinned items keep their stage-1 PLACE but carry their RERANKED score
    // (spec §4.7, F5): one scale across the result. The output check above
    // guarantees every live unit has a reranked entry.
    const rerankedByKey = new Map(reranked.map((u) => [u.key, u] as const));
    const head: Unit[] = [];
    for (const u of live.slice(0, keepTop)) {
      const scored = rerankedByKey.get(u.key);
      if (scored) head.push({ ...scored, pinned: true });
    }
    const headKeys = new Set(head.map((u) => u.key));
    return {
      ok: true,
      value: [...head, ...reranked.filter((u) => !headKeys.has(u.key))],
    };
  }

  /** Hydrate in rank order, in parallel waves, until `keep` items: orphans never use up k. */
  protected async hydrate(
    units: readonly Unit[],
    keep: number,
    ctx: RunContext,
  ): Promise<Result<Hydrated[], RagError>> {
    const out: Hydrated[] = [];
    let next = 0;
    while (out.length < keep && next < units.length) {
      const wave = units.slice(next, next + keep - out.length);
      next += wave.length;
      const got = await Promise.all(wave.map((u) => this.hydrateOne(u, ctx)));
      for (const [i, g] of got.entries()) {
        if (!g.ok) return g;
        const unit = wave[i];
        if (g.value && unit) out.push({ unit, item: g.value });
      }
    }
    return { ok: true, value: out };
  }

  private async hydrateOne(
    u: Unit,
    ctx: RunContext,
  ): Promise<Result<RagResult | null, RagError>> {
    if (!u.item) {
      const rec = u.hits[0];
      return { ok: true, value: rec ? { ...rec, score: u.score } : null };
    }
    const c = await this.canonicalOf(u, ctx);
    if (!c.ok || !c.value) return c;
    return {
      ok: true,
      value: asItem(c.value, u.score, {
        matchedKinds: matchedKinds(u.hits),
        source: u.source.name,
      }),
    };
  }

  /**
   * The canonical record: a canonical hit among the candidates, else one
   * getById on the item's source — owner-checked against the source's filter.
   * Null = orphan, counted once per unit.
   */
  protected async canonicalOf(
    u: Unit,
    ctx: RunContext,
  ): Promise<Result<RagResult | null, RagError>> {
    const item = u.item;
    if (!item) return { ok: true, value: null };
    const cached = ctx.canonicals.get(u.key);
    if (cached !== undefined) return { ok: true, value: cached };
    let rec =
      u.hits.find(
        (h) => h.metadata.recordKind === this.options.canonicalKind,
      ) ?? null;
    if (!rec) {
      ctx.stats.hydrationReads++;
      const r = await settled(() =>
        u.source.rag.getById(item.canonicalId, u.source.options),
      );
      if (!r.ok) return r;
      rec = r.value;
    }
    const valid =
      rec !== null &&
      rec.metadata.itemId === item.itemId &&
      !isExpired(rec.metadata) &&
      matchesRagIdentity(rec.metadata, ragIdentityFilter(u.source.options));
    if (!valid) ctx.stats.orphans++;
    const value = valid ? rec : null;
    ctx.canonicals.set(u.key, value);
    return { ok: true, value };
  }
}
