// packages/llm-agent-libs/src/collections/record-writer.ts
/**
 * The binding's write path (spec §3.1, §3.3, §7.6). Ids come from recordId only;
 * an item is written as: the canonical FIRST (D84: the new `recordIds` AND, written
 * ahead, the stale ids still to delete — every id the item holds or may hold) →
 * the item's other records → deletes of the stale ids, each Result checked → the
 * canonical settled to what is still pending (F3). No record is written that its
 * canonical does not already list. NOT atomic, no locks, no generations (D13):
 * readers stay safe through hydration (§4.6); a failed cleanup is kept, never
 * reported indexed.
 */
import {
  type CallOptions,
  type IRag,
  matchesRagIdentity,
  ownerKeyOf,
  RagError,
  type RagMetadata,
  type RagResult,
  type RecordDraft,
  type RecordOwner,
  type ReservedRecordKey,
  type Result,
  ragIdentityFilter,
  recordId,
  retrievalEmbedderOf,
} from '@mcp-abap-adt/llm-agent';
import { ownerMetadata } from './owner.js';

/**
 * Every reserved key but `id` (the store writes it), explicitly `undefined`, under
 * every record write. InMemoryRag and VectorRag MERGE metadata on the same id, so a
 * key left out would survive a replacement; Qdrant, pg-vector and HANA replace the
 * whole payload and JSON.stringify drops `undefined`, so the same write is right
 * there too (spec §3.3: a replacement replaces the record). `satisfies` makes a key
 * added to ReservedRecordKey a compile error here until it is listed.
 */
const UNSET_RESERVED = {
  itemId: undefined,
  recordKind: undefined,
  itemText: undefined,
  profile: undefined,
  recordIds: undefined,
  staleRecordIds: undefined,
  visibility: undefined,
  userId: undefined,
  groupId: undefined,
  sessionId: undefined,
  ttl: undefined,
} satisfies Record<Exclude<ReservedRecordKey, 'id'>, undefined>;

/** Keys the store itself owns on a read record; never cleared by the writer. */
const STORE_OWN_KEYS: ReadonlySet<string> = new Set([
  'id',
  'text',
  'namespace',
]);

export interface ItemWrite {
  readonly itemId: string;
  readonly drafts: readonly RecordDraft[];
  /** Framework-written expiry (shared items), on every record of the item. */
  readonly ttl?: number;
}

export interface PreparedRecord {
  readonly id: string;
  readonly text: string;
  readonly metadata: RagMetadata;
}

export interface PreparedItem {
  readonly itemId: string;
  readonly owner: RecordOwner;
  readonly canonical: PreparedRecord;
  readonly others: readonly PreparedRecord[];
}

const sameOwner = (a: RecordOwner, b: RecordOwner): boolean =>
  a.scope === b.scope && ownerKeyOf(a) === ownerKeyOf(b);

export function prepareItem(
  w: ItemWrite,
  o: { canonicalKind: string; profile: string; maxRecordsPerItem: number },
): { ok: true; item: PreparedItem } | { ok: false; reason: string } {
  if (w.drafts.length > o.maxRecordsPerItem) {
    return { ok: false, reason: 'too-many-records' };
  }
  const owner = w.drafts[0]?.owner;
  if (!owner) return { ok: false, reason: 'no-records' };
  for (const d of w.drafts) {
    if (d.itemId !== w.itemId) return { ok: false, reason: 'item-id-mismatch' };
    if (!sameOwner(d.owner, owner))
      return { ok: false, reason: 'owner-mismatch' };
  }
  const canonicalDrafts = w.drafts.filter(
    (d) => d.recordKind === o.canonicalKind,
  );
  const canonicalDraft = canonicalDrafts[0];
  if (canonicalDrafts.length !== 1 || !canonicalDraft) {
    return { ok: false, reason: 'missing-canonical' };
  }
  const positions = new Map<string, number>();
  const build = (d: RecordDraft): PreparedRecord => {
    const n = positions.get(d.recordKind) ?? 0;
    positions.set(d.recordKind, n + 1);
    return {
      id: recordId(owner, w.itemId, d.recordKind, n),
      text: d.text,
      metadata: {
        ...UNSET_RESERVED,
        ...(d.metadata ?? {}),
        itemId: w.itemId,
        recordKind: d.recordKind,
        profile: o.profile,
        ...ownerMetadata(owner),
        itemText: d.itemText,
        ttl: w.ttl,
      },
    };
  };
  const canonicalBase = build(canonicalDraft);
  const others = w.drafts.filter((d) => d !== canonicalDraft).map(build);
  const canonical: PreparedRecord = {
    ...canonicalBase,
    metadata: { ...canonicalBase.metadata, recordIds: others.map((r) => r.id) },
  };
  return { ok: true, item: { itemId: w.itemId, owner, canonical, others } };
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** One embedding call for all records when the store's embedder batches; undefined → per-record path. */
async function embedAll(
  rag: IRag,
  records: readonly PreparedRecord[],
  options?: CallOptions,
): Promise<{ vectors?: Map<string, number[]>; failure?: string }> {
  const embedder = retrievalEmbedderOf(rag);
  const writer = rag.writer?.();
  if (
    !embedder?.embedDocuments ||
    !(writer?.upsertManyPrecomputedRaw || writer?.upsertPrecomputedRaw) ||
    records.length === 0
  ) {
    return {};
  }
  try {
    const res = await embedder.embedDocuments(
      records.map((r) => r.text),
      options,
    );
    if (res.length !== records.length) {
      return {
        failure: `embedding returned ${res.length} vectors for ${records.length} texts`,
      };
    }
    return { vectors: new Map(records.map((r, i) => [r.id, res[i].vector])) };
  } catch (err) {
    return { failure: message(err) };
  }
}

/**
 * Write records into one store; the id → error of every record NOT written.
 *
 * Bulk path — a vector for every record and `upsertManyPrecomputedRaw`: ONE call.
 * A bulk failure (`ok: false` or a throw) fails EVERY record of the batch with that
 * error. It is never retried record by record (spec §3.3, D76): a store that
 * refused the batch is not asked again through another write path — that would be
 * a silent substitution hiding the bulk failure.
 * Per-record path — only where the bulk one is not available (no bulk capability,
 * or no precomputed vectors: the store embeds, U7's embedding retry): a record's
 * failure fails that record, with its own error.
 */
async function writeAll(
  rag: IRag,
  records: readonly PreparedRecord[],
  vectors: Map<string, number[]> | undefined,
  written: Set<string>,
  options?: CallOptions,
): Promise<Map<string, string>> {
  const failed = new Map<string, string>();
  if (records.length === 0) return failed;
  const writer = rag.writer?.();
  if (!writer) {
    for (const r of records) failed.set(r.id, 'the store has no writer');
    return failed;
  }
  if (vectors && writer.upsertManyPrecomputedRaw) {
    const batch = records.flatMap((r) => {
      const vector = vectors.get(r.id);
      return vector ? [{ ...r, vector }] : [];
    });
    if (batch.length === records.length) {
      if (options?.signal?.aborted) {
        for (const r of records) failed.set(r.id, 'aborted');
        return failed;
      }
      let error: string;
      try {
        const bulk = await writer.upsertManyPrecomputedRaw(batch, options);
        if (bulk.ok) {
          for (const r of records) written.add(r.id);
          return failed;
        }
        error = bulk.error.message;
      } catch (err) {
        error = message(err);
      }
      // D76: the whole batch fails with the bulk error — no per-record retry.
      for (const r of records) failed.set(r.id, `bulk write failed: ${error}`);
      return failed;
    }
  }
  for (const r of records) {
    if (options?.signal?.aborted) {
      failed.set(r.id, 'aborted');
      continue;
    }
    const vector = vectors?.get(r.id);
    try {
      const res =
        vector && writer.upsertPrecomputedRaw
          ? await writer.upsertPrecomputedRaw(
              r.id,
              r.text,
              vector,
              r.metadata,
              options,
            )
          : await writer.upsertRaw(r.id, r.text, r.metadata, options);
      if (res.ok) written.add(r.id);
      else failed.set(r.id, res.error.message);
    } catch (err) {
      // This record's own failure, reported with its item (`write-failed: <error>`).
      failed.set(r.id, message(err));
    }
  }
  return failed;
}

const listed = (
  meta: RagMetadata | undefined,
  key: 'recordIds' | 'staleRecordIds' = 'recordIds',
): string[] => {
  const raw = meta?.[key];
  return Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string')
    : [];
};

/**
 * The new canonical, with `undefined` for every extra the OLD canonical had and the
 * new one has not — a merging store would otherwise keep it (reserved keys are
 * already all written, UNSET_RESERVED).
 */
function clearingOld(
  c: PreparedRecord,
  old: RagMetadata | undefined,
): PreparedRecord {
  if (!old) return c;
  const dropped = Object.keys(old).filter(
    (k) => !STORE_OWN_KEYS.has(k) && !(k in c.metadata),
  );
  if (dropped.length === 0) return c;
  return {
    ...c,
    metadata: {
      ...Object.fromEntries(dropped.map((k) => [k, undefined])),
      ...c.metadata,
    },
  };
}

/** The canonical with the stale list written onto it (`undefined` when empty). */
function withStale(
  c: PreparedRecord,
  stale: readonly string[],
): PreparedRecord {
  return {
    ...c,
    metadata: {
      ...c.metadata,
      // Always written, `undefined` once settled: InMemoryRag's upsert MERGES metadata
      // on the same id, so an omitted key would keep the previous list.
      staleRecordIds: stale.length > 0 ? [...stale] : undefined,
    },
  };
}

/** Delete each id; `ok` (deleted or already absent) = done; `ok: false` or a throw = kept. */
async function deleteAll(
  rag: IRag,
  ids: readonly string[],
  options?: CallOptions,
): Promise<string[]> {
  const w = rag.writer?.();
  if (!w) return [...ids];
  const kept: string[] = [];
  for (const id of ids) {
    try {
      const d = await w.deleteByIdRaw(id, options);
      if (!d.ok) kept.push(id);
    } catch {
      kept.push(id);
    }
  }
  return kept;
}

/** An item's owner-qualified id, for messages: `user:A/case-42`, `global/tool:read_file`. */
function itemLabel(it: PreparedItem): string {
  const key = ownerKeyOf(it.owner);
  return `${it.owner.scope}${key ? `:${key}` : ''}/${it.itemId}`;
}

/**
 * The batch's duplicate owner-qualified item ids as ONE error, or undefined (spec §3.3).
 * Same owner + item id = same canonical record id. Two versions of one item in one
 * batch would read the same old canonical and overwrite each other's records — the
 * records of the version whose canonical lands first could end up listed nowhere.
 */
export function duplicateItemsError(
  items: readonly PreparedItem[],
): RagError | undefined {
  const seen = new Map<string, { label: string; n: number }>();
  for (const it of items) {
    const e = seen.get(it.canonical.id);
    if (e) e.n++;
    else seen.set(it.canonical.id, { label: itemLabel(it), n: 1 });
  }
  const dups = [...seen.values()].filter((e) => e.n > 1);
  if (dups.length === 0) return undefined;
  return new RagError(
    `index: duplicate item ids in one batch, nothing read or written: ${dups
      .map((d) => `${d.label} (${d.n}×)`)
      .join(', ')}`,
  );
}

/**
 * Write prepared items into ONE store (spec §3.3 order). `indexed[i]` = every
 * record of item i written AND its stale cleanup done (F3). A batch with a
 * duplicate item id is rejected first — nothing read or written (`rejected`).
 * Canonicals first, then the other records of the items whose canonical was
 * written (D84) — two bulk writes on the bulk path, never retried per record (D76).
 */
export async function storeItems(
  rag: IRag,
  items: readonly PreparedItem[],
  options?: CallOptions,
): Promise<{
  indexed: boolean[];
  records: number;
  failures: (string | undefined)[];
  batchFailure?: string;
  rejected?: RagError;
}> {
  // Before any read or write (spec §3.3): no partial batch.
  const rejected = duplicateItemsError(items);
  if (rejected) {
    return {
      indexed: items.map(() => false),
      records: 0,
      failures: items.map(() => rejected.message),
      rejected,
    };
  }
  const failures: (string | undefined)[] = items.map(() => undefined);
  const stale: string[][] = items.map(() => []);
  const olds: (RagMetadata | undefined)[] = items.map(() => undefined);
  await Promise.all(
    items.map(async (it, i) => {
      let r: Result<RagResult | null, RagError>;
      try {
        r = await rag.getById(it.canonical.id, options);
      } catch (err) {
        failures[i] = `read-failed: ${message(err)}`;
        return;
      }
      if (!r.ok) {
        failures[i] = `read-failed: ${r.error.message}`;
        return;
      }
      const old = r.value?.metadata;
      olds[i] = old;
      const keep = new Set([...it.others.map((x) => x.id), it.canonical.id]);
      stale[i] = [
        ...new Set([...listed(old), ...listed(old, 'staleRecordIds')]),
      ].filter((id) => !keep.has(id));
    }),
  );
  // Write ahead (F3): the canonical carries what must still be deleted — and
  // clears the old extras it no longer has (merging stores).
  const prepared = items.map((it, i) => ({
    ...it,
    canonical: withStale(clearingOld(it.canonical, olds[i]), stale[i]),
  }));
  const live = prepared.filter((_, i) => failures[i] === undefined);
  const all = live.flatMap((it) => [...it.others, it.canonical]);
  const { vectors, failure } = await embedAll(rag, all, options);
  const written = new Set<string>();
  // D84: every canonical FIRST — it already lists every id its item holds or may hold
  // (new recordIds + stale), so no record below is ever written untracked. One bulk
  // write for the batch's canonicals on the bulk path.
  const canonicalErrors = await writeAll(
    rag,
    live.map((it) => it.canonical),
    vectors,
    written,
    options,
  );
  // Then the other records — only of the items whose canonical landed (a failed
  // canonical leaves its item's new records unwritten: nothing to orphan). A second
  // bulk write; a failure fails its items, each id already tracked (D76: no retry).
  const tracked = live.filter((it) => written.has(it.canonical.id));
  const otherErrors = await writeAll(
    rag,
    tracked.flatMap((it) => it.others),
    vectors,
    written,
    options,
  );
  const writeErrors = new Map([...canonicalErrors, ...otherErrors]);
  const indexed = await Promise.all(
    prepared.map(async (it, i) => {
      if (failures[i] !== undefined) return false;
      // The canonical first: its error is the item's when it failed (D84).
      const ids = [it.canonical, ...it.others].map((r) => r.id);
      const missing = ids.find((id) => !written.has(id));
      if (missing !== undefined) {
        // The store's own error reaches the report (spec §3.3, D76). No delete or
        // settle: the canonical (if written) keeps the stale set and lists the
        // unwritten id, so the next index / remove cleans up (D84).
        failures[i] =
          `write-failed: ${writeErrors.get(missing) ?? 'not written'}`;
        return false;
      }
      if (stale[i].length === 0) return true;
      // Delete every stale id, each Result checked.
      const left = await deleteAll(rag, stale[i], options);
      // Unchanged list (every delete failed): the canonical already lists exactly
      // what is pending — no settle write (spec §3.3 step 4).
      if (left.length === stale[i].length) {
        failures[i] =
          `cleanup-failed: ${left.length} stale record(s) kept for retry`;
        return false;
      }
      // Settle: the canonical lists exactly what is still pending. A failed settle
      // write is reported, never counted indexed (D76); the written-ahead superset
      // stays, and the retry's delete of an already-deleted id is a no-op.
      const settled = await writeAll(
        rag,
        [withStale(it.canonical, left)],
        vectors,
        new Set<string>(),
        options,
      );
      const settleError = settled.get(it.canonical.id);
      if (settleError !== undefined) {
        failures[i] =
          `cleanup-failed: the settled stale list was not written: ${settleError}`;
        return false;
      }
      const n = left.length;
      if (n > 0) {
        failures[i] = `cleanup-failed: ${n} stale record(s) kept for retry`;
        return false;
      }
      return true;
    }),
  );
  return {
    indexed,
    records: written.size,
    failures,
    ...(failure !== undefined ? { batchFailure: failure } : {}),
  };
}

export function isExpired(
  meta: RagMetadata,
  nowSecs = Date.now() / 1000,
): boolean {
  return typeof meta.ttl === 'number' && meta.ttl < nowSecs;
}

/** An item as returned to readers: the canonical record, `metadata.id` = the logical itemId. */
export function asItem(
  canonical: RagResult,
  score: number,
  extra: { matchedKinds?: string[]; source?: string } = {},
): RagResult {
  return {
    text: canonical.text,
    metadata: {
      ...canonical.metadata,
      // RagMetadata's index signature types itemId as unknown (TS2322 against id?: string);
      // a canonical always carries a string one.
      id:
        typeof canonical.metadata.itemId === 'string'
          ? canonical.metadata.itemId
          : canonical.metadata.id,
      ...extra,
    },
    score,
  };
}

const asRagError = (err: unknown): RagError =>
  err instanceof RagError ? err : new RagError(message(err));

/** `getById`, with a throw turned into its `Result` error (both failure paths). */
async function readCanonical(
  rag: IRag,
  canonicalId: string,
  options?: CallOptions,
): Promise<Result<RagResult | null, RagError>> {
  try {
    return await rag.getById(canonicalId, options);
  } catch (err) {
    return { ok: false, error: asRagError(err) };
  }
}

/** The item whole by its canonical id, or null — identity-checked against `filter` (spec §3.3). */
export async function getItem(
  rag: IRag,
  canonicalId: string,
  filter: CallOptions | undefined,
  options?: CallOptions,
): Promise<Result<RagResult | null, RagError>> {
  const r = await readCanonical(rag, canonicalId, options);
  if (!r.ok) return r;
  const rec = r.value;
  if (
    !rec ||
    isExpired(rec.metadata) ||
    !matchesRagIdentity(rec.metadata, ragIdentityFilter(filter))
  ) {
    return { ok: true, value: null };
  }
  return { ok: true, value: asItem(rec, 1) };
}

/**
 * Delete what the canonical lists AND what it still has pending (F3), then the
 * canonical. Every delete is tried; if any fails, the canonical is KEPT (so a
 * retry finds the list) and an error is returned. Returns records deleted.
 */
export async function removeItem(
  rag: IRag,
  canonicalId: string,
  options?: CallOptions,
): Promise<Result<number, RagError>> {
  const writer = rag.writer?.();
  if (!writer) {
    return {
      ok: false,
      error: new RagError('store has no writer', 'RAG_READ_ONLY'),
    };
  }
  const r = await readCanonical(rag, canonicalId, options);
  if (!r.ok) return r;
  if (!r.value) return { ok: true, value: 0 };
  const meta = r.value.metadata;
  let n = 0;
  /** One delete; its error (an `ok: false` or a throw — both count) or undefined. */
  const del = async (id: string): Promise<RagError | undefined> => {
    try {
      const d = await writer.deleteByIdRaw(id, options);
      if (!d.ok) return d.error;
      if (d.value) n++;
      return undefined;
    } catch (err) {
      return asRagError(err);
    }
  };
  const errors: RagError[] = [];
  for (const id of new Set([
    ...listed(meta),
    ...listed(meta, 'staleRecordIds'),
  ])) {
    const e = await del(id);
    if (e) errors.push(e);
  }
  // The first failure's code and message reach the caller.
  const [first] = errors;
  if (first) {
    return {
      ok: false,
      error: new RagError(
        `remove: ${errors.length} record delete(s) failed; the item is kept so a retry finds them: ${first.message}`,
        first.code,
      ),
    };
  }
  const canonicalError = await del(canonicalId);
  if (canonicalError) {
    return {
      ok: false,
      error: new RagError(
        `remove: the canonical record delete failed: ${canonicalError.message}`,
        canonicalError.code,
      ),
    };
  }
  return { ok: true, value: n };
}
