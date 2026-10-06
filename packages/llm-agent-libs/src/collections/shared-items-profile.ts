// packages/llm-agent-libs/src/collections/shared-items-profile.ts
/**
 * A generic shared base (spec §8): pipeline elements write items through
 * index()/remove(); the profile finds them and returns each item WHOLE, with
 * owner and visibility. What an item holds is the writing element's business.
 * Visibility → partitions (D5): user / global stores given at bind, group
 * stores from the consumer's ISharedItemGroups.
 */
import {
  type CallOptions,
  type IBoundCollection,
  type ICandidatePool,
  type ICollapseRule,
  type ICollectionProfile,
  type IItemCut,
  type IndexNote,
  type IndexReport,
  type IRag,
  type ItemRef,
  ownerKeyOf,
  RagError,
  type RagResult,
  type RecordDraft,
  type RecordOwner,
  type Result,
  type RetrievalSource,
  recordId,
  type SharedItem,
  type SharedItemsStores,
  type SharedItemVisibility,
} from '@mcp-abap-adt/llm-agent';
import { StrategyRag } from '../retrieval/strategy-rag.js';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';
import {
  getItem,
  type PreparedItem,
  prepareItem,
  removeItem,
  storeItems,
} from './record-writer.js';
import {
  StagedRetrieval,
  type StagedRetrievalOptions,
} from './staged-retrieval.js';
import { toRagError } from './to-rag-error.js';

export const SHARED_ITEMS_PROFILE_NAME = 'shared-items';
const CANONICAL = 'item';

export interface SharedItemsProfileOptions {
  /** Required (spec §4.4): index() refuses an item with more records. */
  readonly maxRecordsPerItem: number;
  /** Absent → `ItemPool()`: the caller's k items (D56); deeper only with a reranker. */
  readonly pool?: ICandidatePool;
  readonly collapse: ICollapseRule;
  readonly rerank?: StagedRetrievalOptions['rerank'];
  readonly decompose?: StagedRetrievalOptions['decompose'];
  readonly cut?: IItemCut;
  readonly telemetry?: StagedRetrievalOptions['telemetry'];
}

/** Shared items are read only through `bound.retrieval` (= `bound.rag.query`) and `bound.get` (spec §8.4). */
const NO_DIRECT_READ =
  'shared items are read through bound.retrieval (bound.rag.query) or bound.get(ref) — the partitions have no direct query or bare-id read';

/**
 * What `bound.rag` decorates: the partitions are read by the retrieval itself
 * (`StrategyRag` routes `query` to it). A direct `query` or a bare-id `getById`
 * has no partition to answer from: an error, never an empty success (D69).
 */
class PartitionsRag implements IRag {
  constructor(private readonly target: SharedItemsStores) {}
  async query(): Promise<Result<RagResult[], RagError>> {
    return { ok: false, error: new RagError(NO_DIRECT_READ) };
  }
  /** The fixed partitions (user, global); group stores are per request (`groups.readable`), checked when read. */
  async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    for (const rag of [this.target.user, this.target.global]) {
      if (!rag) continue;
      const r = await rag.healthCheck(options);
      if (!r.ok) return r;
    }
    return { ok: true, value: undefined };
  }
  /** Items are addressed by owner through bound.get(), never by a bare id. */
  async getById(): Promise<Result<RagResult | null, RagError>> {
    return { ok: false, error: new RagError(NO_DIRECT_READ) };
  }
}

/** The request's options without its identity filter (partition stores are not user-scoped). */
const unfiltered = (options?: CallOptions): CallOptions => ({
  ...options,
  ragFilter: undefined,
});

/** An item's owner-qualified id, for messages: `user:A/case-42` (as record-writer's). */
const itemLabel = (owner: RecordOwner, itemId: string): string => {
  const key = ownerKeyOf(owner);
  return `${owner.scope}${key ? `:${key}` : ''}/${itemId}`;
};

/**
 * The batch's duplicate owner-qualified item ids as ONE error, or undefined (spec
 * §3.3), over EVERY item given — also those refused below, so one version being
 * refused never lets the other be written as if it were alone. A shared item's
 * owner is its visibility, known before anything is prepared.
 */
function duplicateBatchError(
  items: readonly SharedItem[],
): RagError | undefined {
  const counts = new Map<string, number>();
  for (const s of items) {
    const l = itemLabel(s.visibility, s.itemId);
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const dups = [...counts].filter(([, n]) => n > 1);
  if (dups.length === 0) return undefined;
  return new RagError(
    `index: duplicate item ids in one batch, nothing read or written: ${dups
      .map(([l, n]) => `${l} (${n}×)`)
      .join(', ')}`,
  );
}

class SharedItemsBinding implements IBoundCollection<SharedItem> {
  readonly profileName = SHARED_ITEMS_PROFILE_NAME;
  readonly rag: IRag;
  readonly retrieval: StagedRetrieval;

  constructor(
    private readonly target: SharedItemsStores,
    private readonly o: SharedItemsProfileOptions,
  ) {
    this.retrieval = new StagedRetrieval({
      name: SHARED_ITEMS_PROFILE_NAME,
      storeKey: target.key,
      pool: o.pool, // absent → StagedRetrieval's ItemPool() (D56)
      maxRecordsPerItem: o.maxRecordsPerItem,
      canonicalKind: CANONICAL,
      sources: { sources: (options) => this.sources(options) },
      collapse: o.collapse,
      ...(o.rerank ? { rerank: o.rerank } : {}),
      ...(o.decompose ? { decompose: o.decompose } : {}),
      ...(o.cut ? { cut: o.cut } : {}),
      ...(o.telemetry ? { telemetry: o.telemetry } : {}),
    });
    this.rag = new StrategyRag(new PartitionsRag(target), this.retrieval);
  }

  get key(): string {
    return this.target.key;
  }

  /** Spec §8.5: `user` (filtered; skipped without a userId — fail closed), `global`, every readable group. */
  private async sources(options?: CallOptions): Promise<RetrievalSource[]> {
    const out: RetrievalSource[] = [];
    const userId = options?.userId;
    if (this.target.user && userId) {
      out.push({
        name: 'user',
        rag: this.target.user,
        options: { ...unfiltered(options), ragFilter: { userId } },
      });
    }
    if (this.target.global) {
      out.push({
        name: 'global',
        rag: this.target.global,
        options: unfiltered(options),
      });
    }
    // A rejecting `readable` (the consumer's authorization) rejects here;
    // StagedRetrieval returns it as the retrieval's Result error.
    for (const g of (await this.target.groups?.readable(options)) ?? []) {
      out.push({
        name: `group:${g.groupId}`,
        rag: g.rag,
        options: unfiltered(options),
      });
    }
    return out;
  }

  /** The store an item of this visibility is written to / removed from, or the refusal reason (spec §8.3). */
  private async writable(
    v: SharedItemVisibility,
    options?: CallOptions,
  ): Promise<IRag | string> {
    switch (v.scope) {
      case 'user':
        if (v.userId !== options?.userId) return 'foreign-user';
        return this.target.user ?? 'no-partition';
      case 'group':
        return (
          (await this.target.groups?.writable(v.groupId, options)) ??
          'no-partition'
        );
      case 'global':
        return this.target.global ?? 'no-partition';
    }
  }

  async index(
    items: readonly SharedItem[],
    options?: CallOptions,
  ): Promise<Result<IndexReport, RagError>> {
    // Spec §3.3: duplicate item ids anywhere in the batch → refused before the FIRST
    // partition is resolved, read or written (a per-store check would leave earlier
    // partitions written).
    const duplicates = duplicateBatchError(items);
    if (duplicates) return { ok: false, error: duplicates };
    const failedItems: { itemId: string; reason: string }[] = [];
    const notes: ({ itemId: string } & IndexNote)[] = [];
    const byStore = new Map<IRag, { at: number; item: PreparedItem }[]>();
    // Pass 1 — every item's partition and records; no store read or write yet.
    for (const [at, s] of items.entries()) {
      const fail = (reason: string) =>
        failedItems.push({ itemId: s.itemId, reason });
      if (
        (s.records ?? []).some(
          (r) => r.kind.length === 0 || r.kind === CANONICAL,
        )
      ) {
        fail('reserved-kind');
        continue;
      }
      // The consumer's `groups.writable` may reject: the call's Result error,
      // before anything is written (fail loud — never a guessed refusal).
      let store: IRag | string;
      try {
        store = await this.writable(s.visibility, options);
      } catch (err) {
        return { ok: false, error: toRagError(err) };
      }
      if (typeof store === 'string') {
        fail(store);
        continue;
      }
      const drafts: RecordDraft[] = [
        {
          text: s.text,
          itemId: s.itemId,
          recordKind: CANONICAL,
          owner: s.visibility,
          ...(s.data !== undefined ? { metadata: { data: s.data } } : {}),
        },
        ...(s.records ?? []).map((r) => ({
          text: r.text,
          itemId: s.itemId,
          recordKind: r.kind,
          owner: s.visibility,
          itemText: s.text,
        })),
      ];
      const p = prepareItem(
        {
          itemId: s.itemId,
          drafts,
          ...(s.ttl !== undefined ? { ttl: s.ttl } : {}),
        },
        {
          canonicalKind: CANONICAL,
          profile: SHARED_ITEMS_PROFILE_NAME,
          maxRecordsPerItem: this.o.maxRecordsPerItem,
        },
      );
      if (!p.ok) {
        fail(p.reason);
        continue;
      }
      const list = byStore.get(store) ?? [];
      list.push({ at, item: p.item });
      byStore.set(store, list);
    }
    let indexedItems = 0;
    let records = 0;
    for (const [store, list] of byStore) {
      // Per partition: canonicals first, then the other records, then stale deletes
      // (D84, Task 11). A throw out of the store (e.g. its `writer()`) is this call's
      // Result error, its code kept.
      let r: Awaited<ReturnType<typeof storeItems>>;
      try {
        r = await storeItems(
          store,
          list.map((l) => l.item),
          options,
        );
      } catch (err) {
        return { ok: false, error: toRagError(err) };
      }
      if (r.rejected) return { ok: false, error: r.rejected };
      records += r.records;
      list.forEach((l, i) => {
        const failure = r.failures[i];
        // U7 (Task 11 carry-over, interim until Task 19B): the batch embedding
        // failed and the store embedded record by record — visible on every item
        // of that partition that went through that path.
        if (
          r.batchFailure !== undefined &&
          !failure?.startsWith('read-failed:')
        ) {
          notes.push({
            itemId: items[l.at].itemId,
            note: 'batch-embedding-failed',
            detail: r.batchFailure,
          });
        }
        if (r.indexed[i]) indexedItems++;
        else
          failedItems.push({
            itemId: items[l.at].itemId,
            reason: failure ?? 'write-failed',
          });
      });
    }
    return {
      ok: true,
      value: {
        items: items.length,
        indexedItems,
        records,
        failedItems,
        ...(notes.length > 0 ? { notes } : {}),
      },
    };
  }

  /** The store `ref` is read from with its identity filter, or undefined (not readable for this request). */
  private async readable(
    ref: ItemRef,
    options?: CallOptions,
  ): Promise<{ rag: IRag; filter: CallOptions } | undefined> {
    switch (ref.owner.scope) {
      case 'user': {
        const userId = options?.userId;
        if (!this.target.user || userId !== ref.owner.userId) return undefined;
        return { rag: this.target.user, filter: { ragFilter: { userId } } };
      }
      case 'group': {
        const groupId = ref.owner.groupId;
        const g = ((await this.target.groups?.readable(options)) ?? []).find(
          (x) => x.groupId === groupId,
        );
        return g ? { rag: g.rag, filter: {} } : undefined;
      }
      case 'global':
        return this.target.global
          ? { rag: this.target.global, filter: {} }
          : undefined;
      default:
        return undefined;
    }
  }

  async get(
    ref: ItemRef,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    let p: { rag: IRag; filter: CallOptions } | undefined;
    try {
      p = await this.readable(ref, options);
    } catch (err) {
      // The consumer's `groups.readable` rejected: the Result error, code kept.
      return { ok: false, error: toRagError(err) };
    }
    if (!p) return { ok: true, value: null };
    return getItem(
      p.rag,
      recordId(ref.owner, ref.itemId, CANONICAL, 0),
      p.filter,
      options,
    );
  }

  async remove(
    refs: readonly ItemRef[],
    options?: CallOptions,
  ): Promise<Result<number, RagError>> {
    // Every ref is checked before anything is deleted: a refused ref never
    // leaves the refs before it removed.
    const targets: { store: IRag; canonicalId: string }[] = [];
    for (const ref of refs) {
      if (ref.owner.scope === 'session') {
        return {
          ok: false,
          error: new RagError(
            `cannot remove ${ref.itemId}: shared items have no session visibility`,
            'OWNER_MISMATCH',
          ),
        };
      }
      let store: IRag | string;
      try {
        store = await this.writable(ref.owner, options);
      } catch (err) {
        return { ok: false, error: toRagError(err) };
      }
      if (typeof store === 'string') {
        return {
          ok: false,
          error: new RagError(
            `cannot remove ${itemLabel(ref.owner, ref.itemId)}: ${store}`,
            store === 'foreign-user' ? 'OWNER_MISMATCH' : 'NO_PARTITION',
          ),
        };
      }
      targets.push({
        store,
        canonicalId: recordId(ref.owner, ref.itemId, CANONICAL, 0),
      });
    }
    let n = 0;
    for (const t of targets) {
      // A Result-returning call that may also reject (a throwing `writer()`):
      // both paths are this call's Result error, the code kept.
      let r: Result<number, RagError>;
      try {
        r = await removeItem(t.store, t.canonicalId, options);
      } catch (err) {
        return { ok: false, error: toRagError(err) };
      }
      if (!r.ok) return r;
      n += r.value;
    }
    return { ok: true, value: n };
  }
}

export class SharedItemsProfile
  implements ICollectionProfile<SharedItem, SharedItemsStores>
{
  readonly name = SHARED_ITEMS_PROFILE_NAME;
  constructor(readonly options: SharedItemsProfileOptions) {
    assertPositiveInteger(
      'SharedItemsProfile',
      'maxRecordsPerItem',
      options.maxRecordsPerItem,
    );
  }
  bind(target: SharedItemsStores): IBoundCollection<SharedItem> {
    return new SharedItemsBinding(target, this.options);
  }
}
