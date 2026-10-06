// packages/llm-agent-libs/src/collections/composed-tools-profile.ts
import {
  type CallOptions,
  type CollectionStore,
  type IBoundCollection,
  type ICandidatePool,
  type ICollapseRule,
  type ICollectionProfile,
  type IItemCut,
  type IItemIndexer,
  type IndexNote,
  type IndexReport,
  type IRag,
  type ISourceSelector,
  type ItemRef,
  isIndexNoteSource,
  ownerKeyOf,
  RagError,
  type RagResult,
  type RecordDraft,
  type RecordOwner,
  type Result,
  recordId,
  type ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { StrategyRag } from '../retrieval/strategy-rag.js';
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

export const TOOLS_PROFILE_NAME = 'mcp-tools';

/** A tools profile = a composition of strategies the consumer injects (spec §7.2). */
export interface ComposedToolsProfileOptions {
  /** Fills the store with records built only from what the provider exports. */
  readonly indexer: IItemIndexer<ToolItem>;
  /** Absent → `ItemPool()`: the caller's k items (D56, spec §7.2). */
  readonly pool?: ICandidatePool;
  readonly collapse: ICollapseRule;
  readonly rerank?: StagedRetrievalOptions['rerank'];
  readonly decompose?: StagedRetrievalOptions['decompose'];
  readonly cut?: IItemCut;
  readonly telemetry?: StagedRetrievalOptions['telemetry'];
}

const reasonOf = (e: RagError): string =>
  e.code === 'TOO_MANY_RECORDS' ? 'too-many-records' : e.message;

/** An item's owner-qualified id, for messages: `global/tool:read_file` (as record-writer's). */
const itemLabel = (owner: RecordOwner, itemId: string): string => {
  const key = ownerKeyOf(owner);
  return `${owner.scope}${key ? `:${key}` : ''}/${itemId}`;
};

/**
 * The batch's duplicate owner-qualified item ids as ONE error, or undefined (spec
 * §3.3, D61), over EVERY item given — also those the indexer refused, so one version
 * failing (e.g. `too-many-records`) never lets the other be written. A ToolItem
 * carries no owner: it is the owner of the item's drafts. An item whose drafts were
 * refused has no known owner, so it cannot be shown to be a different item: it
 * counts as a duplicate of every entry with its item id.
 */
function duplicateBatchError(
  entries: readonly { itemId: string; owner: RecordOwner | undefined }[],
): RagError | undefined {
  const byItem = new Map<string, (RecordOwner | undefined)[]>();
  for (const e of entries) {
    const owners = byItem.get(e.itemId);
    if (owners) owners.push(e.owner);
    else byItem.set(e.itemId, [e.owner]);
  }
  const dups: string[] = [];
  for (const [itemId, owners] of byItem) {
    if (owners.length < 2) continue;
    const known = owners.filter((o): o is RecordOwner => o !== undefined);
    if (known.length < owners.length) {
      const labels = [...new Set(known.map((o) => itemLabel(o, itemId)))];
      dups.push(
        `${labels.length === 1 ? labels[0] : itemId} (${owners.length}×)`,
      );
      continue;
    }
    const counts = new Map<string, number>();
    for (const o of known) {
      const l = itemLabel(o, itemId);
      counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    for (const [l, n] of counts) if (n > 1) dups.push(`${l} (${n}×)`);
  }
  if (dups.length === 0) return undefined;
  return new RagError(
    `index: duplicate item ids in one batch, nothing read or written: ${dups.join(', ')}`,
  );
}

class ToolsBinding implements IBoundCollection<ToolItem> {
  readonly rag: IRag;
  constructor(
    private readonly target: CollectionStore,
    private readonly indexer: IItemIndexer<ToolItem>,
    readonly retrieval: StagedRetrieval,
    readonly profileName: string,
  ) {
    this.rag = new StrategyRag(target.rag, retrieval);
  }

  get key(): string {
    return this.target.key;
  }

  async index(
    items: readonly ToolItem[],
    options?: CallOptions,
  ): Promise<Result<IndexReport, RagError>> {
    const failedItems: { itemId: string; reason: string }[] = [];
    const notes: ({ itemId: string } & IndexNote)[] = [];
    const prepared: { at: number; item: PreparedItem }[] = [];
    // Pass 1 — the indexer's drafts for EVERY item (pure: no store read or write).
    // `toRecords` returns a Result and may also reject: both are that item's failure.
    const drafted: Result<readonly RecordDraft[], RagError>[] = [];
    for (const tool of items) {
      try {
        drafted.push(await this.indexer.toRecords(tool, options));
      } catch (err) {
        drafted.push({ ok: false, error: toRagError(err) });
      }
    }
    // Spec §3.3, D61: a duplicate owner-qualified item id anywhere in the batch →
    // the batch is refused before any store read or write, nothing written.
    const duplicates = duplicateBatchError(
      items.map((tool, at) => {
        const d = drafted[at];
        return {
          itemId: tool.itemId,
          owner: d.ok ? d.value[0]?.owner : undefined,
        };
      }),
    );
    if (duplicates) return { ok: false, error: duplicates };
    // Pass 2 — prepare each item; `notesFor` may throw: that item's failure, reported.
    for (const [at, tool] of items.entries()) {
      const fail = (reason: string) =>
        failedItems.push({ itemId: tool.itemId, reason });
      const drafts = drafted[at];
      if (!drafts.ok) {
        fail(reasonOf(drafts.error));
        continue;
      }
      try {
        const p = prepareItem(
          { itemId: tool.itemId, drafts: drafts.value },
          {
            canonicalKind: this.indexer.canonicalKind,
            profile: this.profileName,
            maxRecordsPerItem: this.indexer.maxRecordsPerItem,
          },
        );
        if (!p.ok) {
          fail(p.reason);
          continue;
        }
        // S1: what the indexer declined to guess, reported with the item's id.
        if (isIndexNoteSource<ToolItem>(this.indexer)) {
          for (const n of this.indexer.notesFor(tool))
            notes.push({ itemId: tool.itemId, ...n });
        }
        prepared.push({ at, item: p.item });
      } catch (err) {
        fail(toRagError(err).message);
      }
    }
    // Write order (spec §3.3, D84): canonical (listing every id) → non-canonical →
    // stale deletes, every delete's Result checked (F3). NOT atomic (D13); readers
    // stay safe through hydration. A throw out of the store (e.g. its `writer()`)
    // is this call's Result error, its code kept.
    let main: Awaited<ReturnType<typeof storeItems>>;
    try {
      main = await storeItems(
        this.target.rag,
        prepared.map((p) => p.item),
        options,
      );
    } catch (err) {
      return { ok: false, error: toRagError(err) };
    }
    let indexedItems = 0;
    prepared.forEach((p, i) => {
      const failure = main.failures[i];
      // U7 (Task 11 carry-over): the batch embedding failed and the store embedded
      // record by record — visible on every item that went through that path
      // (an item whose canonical read failed never reached the embedding).
      if (
        main.batchFailure !== undefined &&
        !failure?.startsWith('read-failed:')
      ) {
        notes.push({
          itemId: items[p.at].itemId,
          note: 'batch-embedding-failed',
          detail: main.batchFailure,
        });
      }
      if (main.indexed[i]) indexedItems++;
      else
        failedItems.push({
          itemId: items[p.at].itemId,
          reason: failure ?? 'write-failed',
        });
    });
    return {
      ok: true,
      value: {
        items: items.length,
        indexedItems,
        records: main.records,
        failedItems,
        ...(notes.length > 0 ? { notes } : {}),
      },
    };
  }

  private canonicalId(ref: ItemRef): string {
    return recordId(ref.owner, ref.itemId, this.indexer.canonicalKind, 0);
  }

  async remove(
    refs: readonly ItemRef[],
    options?: CallOptions,
  ): Promise<Result<number, RagError>> {
    let n = 0;
    for (const ref of refs) {
      // A Result-returning call that may also reject (a throwing `writer()`):
      // both paths are this call's Result error, the code kept.
      let r: Result<number, RagError>;
      try {
        r = await removeItem(this.target.rag, this.canonicalId(ref), options);
      } catch (err) {
        return { ok: false, error: toRagError(err) };
      }
      if (!r.ok) return r;
      n += r.value;
    }
    return { ok: true, value: n };
  }

  get(
    ref: ItemRef,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    return getItem(this.target.rag, this.canonicalId(ref), options, options);
  }
}

/** The tools profile any composition is built with (spec §7.2). */
export class ComposedToolsProfile implements ICollectionProfile<ToolItem> {
  readonly name = TOOLS_PROFILE_NAME;
  constructor(readonly composition: ComposedToolsProfileOptions) {}

  bind(target: CollectionStore): IBoundCollection<ToolItem> {
    const c = this.composition;
    const sources: ISourceSelector = {
      sources: async (options) => [
        { name: 'primary', rag: target.rag, options },
      ],
    };
    const retrieval = new StagedRetrieval({
      name: this.name,
      storeKey: target.key,
      pool: c.pool, // absent → StagedRetrieval's ItemPool() (D56)
      maxRecordsPerItem: c.indexer.maxRecordsPerItem,
      canonicalKind: c.indexer.canonicalKind,
      sources,
      collapse: c.collapse,
      ...(c.rerank ? { rerank: c.rerank } : {}),
      ...(c.decompose ? { decompose: c.decompose } : {}),
      ...(c.cut ? { cut: c.cut } : {}),
      ...(c.telemetry ? { telemetry: c.telemetry } : {}),
    });
    return new ToolsBinding(target, c.indexer, retrieval, this.name);
  }
}
