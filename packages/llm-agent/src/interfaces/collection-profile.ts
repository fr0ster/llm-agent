/**
 * Collection profiles — how one kind of collection is filled and searched
 * (spec docs/superpowers/specs/2026-10-05-collection-profiles-design.md §3).
 * Additive contracts; IRag, IReranker, IRetrievalStrategy, IMetrics unchanged.
 */
import { createHash } from 'node:crypto';
import type { ICounter } from './metrics.js';
import type { IRag, RagJsonValue } from './rag.js';
import type { IRetrievalStrategy } from './retrieval-strategy.js';
import type { CallOptions, RagError, RagResult, Result } from './types.js';

/**
 * Who owns a record and who may see it. `scope` IS the visibility.
 * Flattened by the framework into metadata: `visibility` + the owner key.
 */
export type RecordOwner =
  | { readonly scope: 'global' }
  /** A team or a role, as the consumer defines it. */
  | { readonly scope: 'group'; readonly groupId: string }
  | { readonly scope: 'user'; readonly userId: string }
  | {
      readonly scope: 'session';
      readonly sessionId: string;
      readonly userId?: string;
    };

/**
 * Keys the framework writes; a profile's or writer's extras can never set them.
 * `staleRecordIds` (canonical only): old ids a replacement must still delete; kept
 * until a delete succeeds (F3). No `serviceRecord` key: there is no service record in
 * a store (D54, spec §17.17).
 */
export type ReservedRecordKey =
  | 'id'
  | 'itemId'
  | 'recordKind'
  | 'itemText'
  | 'profile'
  | 'recordIds'
  | 'staleRecordIds'
  | 'visibility'
  | 'userId'
  | 'groupId'
  | 'sessionId'
  | 'ttl';

export interface IndexedRecord {
  /**
   * The PHYSICAL store id, assigned by the binding — never by the indexer:
   * `recordId(owner, itemId, recordKind, n)`, n = the record's position within its kind.
   */
  readonly id: string;
  /** The text that is embedded. */
  readonly text: string;
  /** The LOGICAL item id. Not unique in a store: two owners may use the same one. */
  readonly itemId: string;
  readonly recordKind: string;
  /** Required: no record without an owner. */
  readonly owner: RecordOwner;
  /** Non-canonical records in an items store: the item text, for the reranker. */
  readonly itemText?: string;
  /** Profile extras (e.g. `name` for tools). Reserved keys cannot be set here. */
  readonly metadata?: Readonly<Record<string, RagJsonValue>> & {
    readonly [K in ReservedRecordKey]?: never;
  };
}

/** What an indexer produces. The physical id is not the indexer's to choose. */
export type RecordDraft = Omit<IndexedRecord, 'id'>;

/** Addresses one item for get / remove. The owner selects the partition AND the record ids. */
export interface ItemRef {
  readonly itemId: string;
  readonly owner: RecordOwner;
}

const SCOPE_CODE: Readonly<Record<RecordOwner['scope'], string>> = {
  global: 'g',
  group: 'grp',
  user: 'u',
  session: 's',
};

/** The owner key that goes into a record id (`session`'s optional userId is not part of it). */
export function ownerKeyOf(owner: RecordOwner): string {
  switch (owner.scope) {
    case 'global':
      return '';
    case 'group':
      return owner.groupId;
    case 'user':
      return owner.userId;
    case 'session':
      return owner.sessionId;
  }
}

const MAX_READABLE_ID = 200;

/**
 * The one id function (spec §3.1). Pure and deterministic; exported so a
 * consumer's own profile uses it too. Ids longer than 200 characters become
 * `h:` + sha256 hex (66 characters) — pg-vector and HANA cap ids at 255.
 */
export function recordId(
  owner: RecordOwner,
  itemId: string,
  kind: string,
  n: number,
): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(
      `recordId: n must be a non-negative integer (got ${n})`,
    );
  }
  const readable = `${SCOPE_CODE[owner.scope]}:${encodeURIComponent(
    ownerKeyOf(owner),
  )}/${encodeURIComponent(itemId)}#${encodeURIComponent(kind)}:${n}`;
  return readable.length <= MAX_READABLE_ID
    ? readable
    : `h:${createHash('sha256').update(readable).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// §3.2 Indexing half
// ---------------------------------------------------------------------------

/** The indexing strategy. */
export interface IItemIndexer<TItem> {
  readonly name: string;
  /** Upper bound on the records it makes per item (canonical included). Sizes the item pool. */
  readonly maxRecordsPerItem: number;
  /** The kind of the item's canonical record (`full` for tools, `item` for shared items). */
  readonly canonicalKind: string;
  /** Pure mapping item → record drafts: exactly one draft of `canonicalKind`.
   *  The binding assigns ids. */
  toRecords(
    item: TItem,
    options?: CallOptions,
  ): Promise<Result<readonly RecordDraft[], RagError>>;
}

export interface IndexReport {
  /** Items given. */
  readonly items: number;
  /** Items with every record written. */
  readonly indexedItems: number;
  /** Records written. */
  readonly records: number;
  readonly failedItems: readonly {
    readonly itemId: string;
    readonly reason: string;
  }[];
  /** Not failures, but they changed what was written (e.g. `ambiguous-discriminator`).
   *  Absent when there are none. */
  readonly notes?: readonly ({ readonly itemId: string } & IndexNote)[];
}

/** Something an indexing strategy declined to guess, about one item. */
export interface IndexNote {
  /** e.g. 'ambiguous-discriminator'. */
  readonly note: string;
  /** e.g. the candidate parameter names. */
  readonly detail?: string;
}

/**
 * Optional capability (S1): a strategy with notes about an item. The binding asks
 * every indexer that has it after `toRecords` and copies the notes, with the
 * item's id, into IndexReport.notes. A decorating indexer forwards to what it wraps.
 */
export interface IIndexNoteSource<TItem> {
  /** Pure: the same item always gets the same notes. Empty → nothing to report. */
  notesFor(item: TItem): readonly IndexNote[];
}

export function isIndexNoteSource<TItem>(
  x: unknown,
): x is IIndexNoteSource<TItem> {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { notesFor?: unknown }).notesFor === 'function'
  );
}

// ---------------------------------------------------------------------------
// §3.3 The profile and its binding
// ---------------------------------------------------------------------------

/** What a binding is attached to. Each profile names its own shape. */
export interface BindTarget {
  /** The ragStores key. */
  readonly key: string;
}

/** The tools profile's target: one store (no companion stores, D50). */
export interface CollectionStore extends BindTarget {
  readonly rag: IRag;
}

export interface IBoundCollection<TItem> {
  readonly key: string;
  readonly profileName: string;
  /** The store to register under `key` (the retrieval below is applied to it). */
  readonly rag: IRag;
  /** Filling half. Re-indexing writes the new records and deletes the old ones the
   *  canonical no longer lists (`recordIds`). Several writes — NOT atomic. */
  index(
    items: readonly TItem[],
    options?: CallOptions,
  ): Promise<Result<IndexReport, RagError>>;
  /** Delete the records the item's canonical record lists, then the canonical record. */
  remove(
    refs: readonly ItemRef[],
    options?: CallOptions,
  ): Promise<Result<number, RagError>>;
  /** The item whole (its canonical record), or null. Identity-checked against `options`. */
  get(
    ref: ItemRef,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>>;
  /** Searching half. `k` counts ITEMS. */
  readonly retrieval: IRetrievalStrategy;
}

export interface ICollectionProfile<
  TItem,
  TTarget extends BindTarget = CollectionStore,
> {
  /** 'mcp-tools' | 'shared-items' | a consumer's own. */
  readonly name: string;
  bind(target: TTarget): IBoundCollection<TItem>;
}

// ---------------------------------------------------------------------------
// §3.4 Retrieval parts
// ---------------------------------------------------------------------------

/** A candidate record and the items source it belongs to. */
export type SourcedHit = RagResult & { readonly source: string };

export interface CollapsedItem {
  /** The items source it belongs to. */
  readonly source: string;
  /** Read back from the hits' metadata (visibility + keys). */
  readonly owner: RecordOwner;
  readonly itemId: string;
  /** Per the rule. */
  readonly score: number;
  /** The item's records among the candidates, best first. */
  readonly hits: readonly RagResult[];
}

/** The candidate strategy: how many items stage 1 hands on, and how deep to query for them.
 *  Both take the caller's k of the (sub-)query, so a pool can default to it (D56, spec §3.4). */
export interface ICandidatePool {
  readonly name: string;
  /** Items kept per source after collapse, for a (sub-)query whose k is `requestedK`. */
  items(requestedK: number): number;
  /** Records to ask one source for, given that k and the indexer's bound on records per item. */
  recordsToFetch(requestedK: number, maxRecordsPerItem: number): number;
}

/** Records → items. Key = (items source, owner scope, owner key, itemId) — never the bare
 *  itemId. Output sorted by score, descending. */
export interface ICollapseRule {
  readonly name: string;
  collapse(hits: readonly SourcedHit[]): CollapsedItem[];
}

/** Final cut over the ranked, hydrated items. Applied once; returns a rank-order PREFIX. */
export interface IItemCut {
  readonly name: string;
  /** An UPPER BOUND, in items, on what `cut` returns for `requestedK` — never above
   *  `requestedK` (the caller's k caps every cut, spec §4.9). The retrieval's budget.
   *  A cut may stop earlier; it never returns more than this. */
  limit(requestedK: number): number;
  cut(items: readonly RagResult[], requestedK: number): RagResult[];
}

/** How big an item is for the prompt, in (estimated) tokens. */
export interface IItemSizeEstimator {
  readonly name: string;
  /** A non-negative integer. Pure: the same item always gets the same size. */
  estimate(item: RagResult): number;
}

/**
 * Optional capability (S6): a cut bounded by a size budget. StagedRetrieval reads
 * it for `cut.tokens` / `cut.budgetTokens` and `outcome=over_budget`.
 */
export interface ISizeBoundedCut {
  readonly budgetTokens: number;
  /** The estimator the cut sizes items with — the one the telemetry sums. */
  readonly estimator: IItemSizeEstimator;
}

export function isSizeBoundedCut(
  cut: IItemCut,
): cut is IItemCut & ISizeBoundedCut {
  const c = cut as Partial<ISizeBoundedCut>;
  return (
    typeof c.budgetTokens === 'number' &&
    Number.isInteger(c.budgetTokens) &&
    c.budgetTokens > 0 &&
    typeof c.estimator === 'object' &&
    c.estimator !== null &&
    typeof c.estimator.estimate === 'function'
  );
}

/** One sub-query and its share of the budget, in items. */
export interface SubQuery {
  readonly text: string;
  /** Integer ≥ 1. */
  readonly k: number;
}

/** Splits one query into budgeted sub-queries. Injected; none → the query runs as is. */
export interface IQueryDecomposer {
  readonly name: string;
  /** `budget` = the retrieval's limit in items. The sub-queries' `k` must sum to ≤ `budget`.
   *  An empty array = run the query as is with the whole budget. */
  decompose(
    text: string,
    budget: number,
    options?: CallOptions,
  ): Promise<Result<readonly SubQuery[], RagError>>;
}

/** One store a retrieval queries. */
export interface RetrievalSource {
  /** Reported in telemetry: 'primary', 'user', 'global', 'group:<id>'. Every source holds
   *  items (their canonical records); a hit belongs to the source it came from. */
  readonly name: string;
  readonly rag: IRag;
  /** The options this source is queried with (its identity filter). */
  readonly options?: CallOptions;
}

/** Which sources a request may query. A profile supplies it; the consumer may replace it. */
export interface ISourceSelector {
  sources(options?: CallOptions): Promise<readonly RetrievalSource[]>;
}

/** A separate small interface (ISP), not a new member of IMetrics. */
export interface IRetrievalMetrics {
  /** Attributes: store, strategy, outcome. */
  readonly retrievalOutcome: ICounter;
}

export function isRetrievalMetrics(m: unknown): m is IRetrievalMetrics {
  if (typeof m !== 'object' || m === null) return false;
  const c = (m as { retrievalOutcome?: unknown }).retrievalOutcome;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof (c as { add?: unknown }).add === 'function'
  );
}

// ---------------------------------------------------------------------------
// §3.5 Tool items
// ---------------------------------------------------------------------------

/** Read from what ANY MCP server exports (`tools/list`): name, description, inputSchema. */
export interface ToolItem {
  /** The IToolRecordKey output, e.g. `tool:read_file`. */
  readonly itemId: string;
  /** Exposed (namespaced) name → metadata.name. */
  readonly name: string;
  /** Provider's name (pre-namespace); facets derive from it. */
  readonly originalName: string;
  readonly description: string;
  /** Top-level `inputSchema.properties`, in schema order. */
  readonly parameters: readonly ToolParameter[];
  /** The input schema exactly as exported — for a consumer's own strategies. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Characters of JSON { name, description, inputSchema } as exported. */
  readonly definitionChars: number;
}

export interface ToolParameter {
  readonly name: string;
  readonly description?: string;
  /** Listed in `inputSchema.required`. */
  readonly required: boolean;
  /** String values from `enum`, or from `oneOf` / `anyOf` entries with a string `const`. */
  readonly values: readonly ToolParameterValue[];
}

export interface ToolParameterValue {
  readonly value: string;
  readonly description?: string;
}

/** One extra record view of a tool, derived from provider text only. */
export interface IToolFacet {
  /** The record kind, e.g. 'summary'. */
  readonly kind: string;
  /** The record text, or undefined when the provider text yields nothing (no record then). */
  derive(tool: ToolItem): string | undefined;
}

/** Composes the provider text of a tool — the canonical `full` record's text, also the
 *  reranker's item text and every non-canonical record's `itemText` (spec §3.5, §7.3.1).
 *  Provider words only. Non-empty; pure. */
export interface IToolTextComposer {
  readonly name: string;
  compose(tool: ToolItem): string;
}

/** Picks a coarse tool's discriminating parameter. Undefined → no per-value records. */
export interface IDiscriminatorSelector {
  readonly name: string;
  select(tool: ToolItem): ToolParameter | undefined;
}

// ---------------------------------------------------------------------------
// §3.6 Shared items
// ---------------------------------------------------------------------------

/** Who may see a shared item. No 'session': a shared item outlives the session. */
export type SharedItemVisibility = Exclude<RecordOwner, { scope: 'session' }>;

export interface SharedItem {
  /** Chosen by the writer. A deterministic id is the writer's tool for de-duplication. */
  readonly itemId: string;
  readonly visibility: SharedItemVisibility;
  /** The item whole, as readers get it back. Also searchable (canonical record `item`). */
  readonly text: string;
  /** Extra search records; kinds of the writer's choosing (not 'item'). */
  readonly records?: readonly {
    readonly kind: string;
    readonly text: string;
  }[];
  /** The writer's structured payload, returned whole with the item. */
  readonly data?: RagJsonValue;
  /** Expiry, epoch seconds → metadata.ttl. The policy is the writer's. */
  readonly ttl?: number;
}

/** The consumer's group partitions (group isolation is the consumer's). */
export interface ISharedItemGroups {
  /** Group stores this request may read — the consumer's authorization. */
  readable(
    options?: CallOptions,
  ): Promise<readonly { readonly groupId: string; readonly rag: IRag }[]>;
  /** The store for writing this group's items; undefined → the write is refused. */
  writable(groupId: string, options?: CallOptions): Promise<IRag | undefined>;
}

/** The shared-items profile's target. At least one of user / global (typed). */
export type SharedItemsStores = BindTarget & {
  readonly groups?: ISharedItemGroups;
} & (
    | { readonly user: IRag; readonly global?: IRag }
    | { readonly user?: IRag; readonly global: IRag }
  );
