// Qdrant (vector-DB) store provider + a durable Postgres catalog store — the
// PERSISTENT, recall-only serving backend for the skill plugin-host.
//
// It implements the SAME contracts as the in-memory store (`ISkillsStoreProvider`
// write side, `ISkillsRagBackendProvider` read side from `@mcp-abap-adt/llm-agent`),
// but the catalog/fence lives in an external CAS-capable `ICatalogStore` and the
// vector points live in Qdrant, tagged by a generation label.
//
// Design (see docs/superpowers/plans/...skill-plugin-host-gnostification.md, Task A10):
//   1. Catalog in a durable CAS-capable `ICatalogStore`. Two impls:
//      `makeInProcessCatalogStore()` (dev / in-process) and `makePgCatalogStore()`
//      (production — one row, conditional `UPDATE ... WHERE revision=$expected`).
//   2. Point ids = deterministic UUIDv5 of `${generation}:${recordId}`.
//   3. carryForward via a paginated `scroll(filter)` client primitive.
//   4. Durable + crash-resumable retirement + AGE-PROTECTED orphan sweep.
//   5. Read-only reader interfaces (`IQdrantReader`, `ICatalogReader`) for the
//      no-write-credentials recall-only serving process.
//
// NOTE on dependencies: `pointId` is a self-contained UUIDv5 implementation over
// `node:crypto`'s sha1 (the standard name-based UUID algorithm) — no `uuid`
// package is added. The pg backends are typed against a MINIMAL injected pool
// interface (`IPgPool`) so NO real `pg` dependency is required; the production
// caller passes a real `pg` `Pool` (structurally compatible) and tests pass a
// fake pool. The Qdrant/pg REST adapters (`makeQdrantClient` / `makeQdrantReader`)
// talk to Qdrant over global `fetch` and are LIVE-ONLY (no unit test; Phase C smoke).

import { createHash, randomUUID } from 'node:crypto';
import type {
  ActiveSnapshot,
  CallOptions,
  CatalogEntry,
  CatalogSnapshot,
  ISkillsRagBackend,
  ISkillsRagBackendProvider,
  ISkillsStore,
  ISkillsStoreProvider,
  RetiredGeneration,
  SkillHit,
  SkillRecord,
} from '@mcp-abap-adt/llm-agent';
import { CatalogCasError } from '@mcp-abap-adt/llm-agent'; // value (class), not a type

// ----------------------------------------------------------------------------
// Client / reader interfaces (minimal, mockable) — WRITE is a superset of READ.
// ----------------------------------------------------------------------------

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface IQdrantReader {
  search(
    filter: object,
    vector: number[],
    k: number,
    options?: { signal?: AbortSignal },
  ): Promise<Array<{ payload: Record<string, unknown>; score: number }>>;
  scroll(
    filter: object,
    cursor?: string,
  ): Promise<{ points: QdrantPoint[]; next?: string }>;
}

export interface IQdrantClient extends IQdrantReader {
  upsertPoints(points: QdrantPoint[]): Promise<void>;
  deleteByFilter(filter: object): Promise<void>;
}

export interface ICatalogReader {
  read(): Promise<CatalogSnapshot>;
}

export interface ICatalogStore extends ICatalogReader {
  // ATOMIC compare-and-set. Throws CatalogCasError if the active revision != expected.
  // The STORE generates the next revision, STAMPS retiredAt on generations dropped from
  // the active set, and returns the COMMITTED snapshot.
  casPublish(
    expectedCatalogRevision: string,
    entries: readonly CatalogEntry[],
    now: number,
  ): Promise<CatalogSnapshot>;
  // Remove fully-reclaimed generations from the durable `retired` list. Fenced like casPublish.
  pruneRetired(
    expectedCatalogRevision: string,
    generations: readonly string[],
  ): Promise<CatalogSnapshot>;
}

type Embed = (text: string, options?: CallOptions) => Promise<number[]>;
type PointId = (generation: string, recordId: string) => string;

// ----------------------------------------------------------------------------
// pointId — deterministic UUIDv5 of `${generation}:${recordId}` (no `uuid` dep).
// ----------------------------------------------------------------------------

// Fixed namespace UUID for skill points (a stable, arbitrary v4 constant).
const SKILL_POINT_NAMESPACE = 'b9c3f6e2-5a1d-4e7b-9f3a-2c6d8e0a1b4f';

function uuidv5(name: string, namespace: string): string {
  // RFC 4122 §4.3 name-based UUID (version 5, SHA-1).
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(nsBytes)
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = hash.subarray(0, 16);
  // set version (5) and variant (RFC 4122) bits
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const pointId: PointId = (generation, recordId) =>
  uuidv5(`${generation}:${recordId}`, SKILL_POINT_NAMESPACE);

// ----------------------------------------------------------------------------
// Catalog snapshot revision generation helper.
// ----------------------------------------------------------------------------

// Compute the durable `retired[]` for a pointer swap: generations active BEFORE
// that are NOT active AFTER get a fresh `retiredAt` stamp; previously-retired
// generations are preserved (idempotent — keep the earliest stamp).
function computeRetired(
  prevEntries: readonly CatalogEntry[],
  prevRetired: readonly RetiredGeneration[],
  nextEntries: readonly CatalogEntry[],
  now: number,
): RetiredGeneration[] {
  const nextActive = new Set(
    nextEntries.filter((e) => !e.tombstone).map((e) => e.generation),
  );
  const retired = new Map<string, RetiredGeneration>();
  // preserve already-retired generations (do not refresh their stamp)
  for (const r of prevRetired) retired.set(r.generation, r);
  // newly-dropped active generations
  for (const e of prevEntries) {
    if (e.tombstone) continue;
    if (nextActive.has(e.generation)) continue;
    if (retired.has(e.generation)) continue;
    retired.set(e.generation, {
      generation: e.generation,
      group: e.collection.group,
      retiredAt: now,
    });
  }
  return [...retired.values()];
}

// ----------------------------------------------------------------------------
// makeInProcessCatalogStore — monotonic-counter revision, in-memory durable-ish.
// ----------------------------------------------------------------------------

export function makeInProcessCatalogStore(): ICatalogStore {
  let revision = 'c0';
  let entries: readonly CatalogEntry[] = [];
  let retired: readonly RetiredGeneration[] = [];

  const nextRevision = () => `c${Number(revision.slice(1)) + 1}`;

  return {
    async read(): Promise<CatalogSnapshot> {
      return {
        catalogRevision: revision,
        entries: entries.filter((e) => !e.tombstone),
        retired,
      };
    },
    async casPublish(expected, next, now): Promise<CatalogSnapshot> {
      if (expected !== revision) {
        throw new CatalogCasError(
          `stale catalog revision: expected ${expected}, active ${revision}`,
        );
      }
      retired = computeRetired(entries, retired, next, now);
      entries = [...next];
      revision = nextRevision();
      return {
        catalogRevision: revision,
        entries: entries.filter((e) => !e.tombstone),
        retired,
      };
    },
    async pruneRetired(expected, generations): Promise<CatalogSnapshot> {
      if (expected !== revision) {
        throw new CatalogCasError(
          `stale catalog revision: expected ${expected}, active ${revision}`,
        );
      }
      const drop = new Set(generations);
      retired = retired.filter((r) => !drop.has(r.generation));
      revision = nextRevision();
      return {
        catalogRevision: revision,
        entries: entries.filter((e) => !e.tombstone),
        retired,
      };
    },
  };
}

// ----------------------------------------------------------------------------
// Postgres catalog store — durable production CAS over a MINIMAL injected pool.
// ----------------------------------------------------------------------------

export interface IPgPool {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number }>;
}

interface PgRow {
  revision: string;
  snapshot: CatalogSnapshot;
}

const PG_ROW_ID = 'skills_catalog';

// A fresh, collision-resistant revision token (the pg backend cannot use a simple
// process-local counter — it is shared across processes and survives restarts).
function freshRevisionToken(): string {
  return createHash('sha1')
    .update(`${Date.now()}:${Math.random()}:${process.pid}`)
    .digest('hex')
    .slice(0, 24);
}

function parseSnapshot(raw: unknown): CatalogSnapshot {
  if (typeof raw === 'string') return JSON.parse(raw) as CatalogSnapshot;
  return raw as CatalogSnapshot;
}

async function pgRead(pool: IPgPool, table: string): Promise<PgRow | null> {
  const res = await pool.query(
    `SELECT revision, snapshot FROM ${table} WHERE id = $1`,
    [PG_ROW_ID],
  );
  if (res.rowCount === 0 || res.rows.length === 0) return null;
  const row = res.rows[0] as { revision: string; snapshot: unknown };
  return { revision: row.revision, snapshot: parseSnapshot(row.snapshot) };
}

export function makePgCatalogStore(deps: {
  pool: IPgPool;
  table?: string;
}): ICatalogStore {
  const { pool } = deps;
  const table = deps.table ?? 'skills_catalog';

  async function ensureRow(): Promise<PgRow> {
    const existing = await pgRead(pool, table);
    if (existing) return existing;
    // seed the single row with an initial empty snapshot
    const revision = freshRevisionToken();
    const snapshot: CatalogSnapshot = {
      catalogRevision: revision,
      entries: [],
      retired: [],
    };
    await pool.query(
      `INSERT INTO ${table} (id, revision, snapshot) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [PG_ROW_ID, revision, JSON.stringify(snapshot)],
    );
    return (await pgRead(pool, table)) ?? { revision, snapshot };
  }

  async function casWrite(
    expected: string,
    snapshot: CatalogSnapshot,
  ): Promise<CatalogSnapshot> {
    const res = await pool.query(
      `UPDATE ${table} SET revision = $1, snapshot = $2
       WHERE id = '${PG_ROW_ID}' AND revision = $3`,
      [snapshot.catalogRevision, JSON.stringify(snapshot), expected],
    );
    if (res.rowCount === 0) {
      throw new CatalogCasError(
        `stale catalog revision: expected ${expected} (UPDATE matched 0 rows)`,
      );
    }
    return snapshot;
  }

  return {
    async read(): Promise<CatalogSnapshot> {
      const row = await ensureRow();
      const snap = row.snapshot;
      // keep the durable revision authoritative on read
      return {
        catalogRevision: row.revision,
        entries: (snap.entries ?? []).filter((e) => !e.tombstone),
        retired: snap.retired ?? [],
      };
    },
    async casPublish(expected, next, now): Promise<CatalogSnapshot> {
      const row = await ensureRow();
      const retired = computeRetired(
        row.snapshot.entries ?? [],
        row.snapshot.retired ?? [],
        next,
        now,
      );
      const snapshot: CatalogSnapshot = {
        catalogRevision: freshRevisionToken(),
        entries: [...next],
        retired,
      };
      await casWrite(expected, snapshot);
      // return the served view (tombstones filtered like read())
      return {
        catalogRevision: snapshot.catalogRevision,
        entries: snapshot.entries.filter((e) => !e.tombstone),
        retired: snapshot.retired,
      };
    },
    async pruneRetired(expected, generations): Promise<CatalogSnapshot> {
      const row = await ensureRow();
      const drop = new Set(generations);
      const snapshot: CatalogSnapshot = {
        catalogRevision: freshRevisionToken(),
        entries: row.snapshot.entries ?? [],
        retired: (row.snapshot.retired ?? []).filter(
          (r) => !drop.has(r.generation),
        ),
      };
      await casWrite(expected, snapshot);
      return {
        catalogRevision: snapshot.catalogRevision,
        entries: snapshot.entries.filter((e) => !e.tombstone),
        retired: snapshot.retired,
      };
    },
  };
}

export function makePgCatalogReader(deps: {
  pool: IPgPool;
  table?: string;
}): ICatalogReader {
  const { pool } = deps;
  const table = deps.table ?? 'skills_catalog';
  return {
    async read(): Promise<CatalogSnapshot> {
      const row = await pgRead(pool, table);
      if (!row) return { catalogRevision: 'c0', entries: [], retired: [] };
      return {
        catalogRevision: row.revision,
        entries: (row.snapshot.entries ?? []).filter((e) => !e.tombstone),
        retired: row.snapshot.retired ?? [],
      };
    },
  };
}

// ----------------------------------------------------------------------------
// Qdrant REST adapters (LIVE-ONLY — no unit test; Phase C smoke).
// ----------------------------------------------------------------------------

interface QdrantRestOptions {
  url: string;
  apiKey?: string;
  collection: string;
}

// Translate the flat filter object used internally into a Qdrant `must` filter.
function toQdrantFilter(filter: Record<string, unknown>): object {
  const must: object[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (Array.isArray(value)) {
      must.push({ key, match: { any: value } });
    } else if (value !== undefined) {
      must.push({ key, match: { value } });
    }
  }
  return { must };
}

function qdrantHeaders(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) h['api-key'] = apiKey;
  return h;
}

function makeQdrantReaderImpl(opts: QdrantRestOptions): IQdrantReader {
  const base = `${opts.url.replace(/\/$/, '')}/collections/${opts.collection}`;
  return {
    async search(filter, vector, k, options) {
      const res = await fetch(`${base}/points/search`, {
        method: 'POST',
        headers: qdrantHeaders(opts.apiKey),
        body: JSON.stringify({
          vector,
          limit: k,
          with_payload: true,
          filter: toQdrantFilter(filter as Record<string, unknown>),
        }),
        signal: options?.signal,
      });
      if (!res.ok) throw new Error(`qdrant search failed: ${res.status}`);
      const json = (await res.json()) as {
        result: Array<{ payload: Record<string, unknown>; score: number }>;
      };
      return json.result.map((r) => ({ payload: r.payload, score: r.score }));
    },
    async scroll(filter, cursor) {
      const res = await fetch(`${base}/points/scroll`, {
        method: 'POST',
        headers: qdrantHeaders(opts.apiKey),
        body: JSON.stringify({
          limit: 256,
          with_payload: true,
          with_vector: true,
          offset: cursor ?? undefined,
          filter: toQdrantFilter(filter as Record<string, unknown>),
        }),
      });
      if (!res.ok) throw new Error(`qdrant scroll failed: ${res.status}`);
      const json = (await res.json()) as {
        result: {
          points: Array<{
            id: string;
            vector: number[];
            payload: Record<string, unknown>;
          }>;
          next_page_offset?: string | null;
        };
      };
      return {
        points: json.result.points.map((p) => ({
          id: p.id,
          vector: p.vector,
          payload: p.payload,
        })),
        next: json.result.next_page_offset ?? undefined,
      };
    },
  };
}

/** Read-only Qdrant reader (search + scroll). Used by recall-only with a read key. */
export function makeQdrantReader(opts: QdrantRestOptions): IQdrantReader {
  return makeQdrantReaderImpl(opts);
}

/** Read/write Qdrant client (reader + upsert + delete). Used by the ingest path. */
export function makeQdrantClient(opts: QdrantRestOptions): IQdrantClient {
  const reader = makeQdrantReaderImpl(opts);
  const base = `${opts.url.replace(/\/$/, '')}/collections/${opts.collection}`;
  return {
    ...reader,
    async upsertPoints(points) {
      const res = await fetch(`${base}/points`, {
        method: 'PUT',
        headers: qdrantHeaders(opts.apiKey),
        body: JSON.stringify({
          points: points.map((p) => ({
            id: p.id,
            vector: p.vector,
            payload: p.payload,
          })),
        }),
      });
      if (!res.ok) throw new Error(`qdrant upsert failed: ${res.status}`);
    },
    async deleteByFilter(filter) {
      const res = await fetch(`${base}/points/delete`, {
        method: 'POST',
        headers: qdrantHeaders(opts.apiKey),
        body: JSON.stringify({
          filter: toQdrantFilter(filter as Record<string, unknown>),
        }),
      });
      if (!res.ok) throw new Error(`qdrant delete failed: ${res.status}`);
    },
  };
}

// ----------------------------------------------------------------------------
// Read-side: map a Qdrant payload → SkillHit; resolve active generation.
// ----------------------------------------------------------------------------

function payloadToHit(
  payload: Record<string, unknown>,
  score: number,
): SkillHit {
  const record: SkillRecord = {
    id: String(payload.recordId ?? ''),
    sourceId: String(payload.sourceId ?? ''),
    group: String(payload.group ?? ''),
    name: String(payload.name ?? ''),
    retrievalText: '', // not needed at read time
    content: String(payload.content ?? ''),
    provenance: String(payload.provenance ?? ''),
  };
  return { record, score };
}

function activeFromCatalog(
  snap: CatalogSnapshot,
  group: string,
): ActiveSnapshot | null {
  const e = snap.entries.find(
    (x) => x.collection.group === group && !x.tombstone,
  );
  return e ? { revision: e.generation, manifest: e.manifest } : null;
}

function readBackendFor(
  reader: IQdrantReader,
  catalogReader: ICatalogReader,
  group: string,
): ISkillsRagBackend {
  return {
    async activeSnapshot(): Promise<ActiveSnapshot | null> {
      return activeFromCatalog(await catalogReader.read(), group);
    },
    // Qdrant retention is best-effort time-grace (not a lease) — release is a no-op.
    release(): void {},
    async queryRevision(revision, vector, k, options): Promise<SkillHit[]> {
      const results = await reader.search({ generation: revision }, vector, k, {
        signal: options?.signal,
      });
      return results.map((r) => payloadToHit(r.payload, r.score));
    },
  };
}

/** Read-only backend provider over reader interfaces (no write/reconcile API). */
export function makeQdrantBackendProvider(deps: {
  reader: IQdrantReader;
  catalogReader: ICatalogReader;
  collection: string;
}): ISkillsRagBackendProvider {
  return {
    async readCatalog(): Promise<CatalogSnapshot> {
      return deps.catalogReader.read();
    },
    forGroup(group: string): ISkillsRagBackend {
      return readBackendFor(deps.reader, deps.catalogReader, group);
    },
  };
}

// ----------------------------------------------------------------------------
// Write-side: makeQdrantStoreProvider.
// ----------------------------------------------------------------------------

export interface QdrantStoreProviderDeps {
  client: IQdrantClient;
  collection: string;
  catalogStore: ICatalogStore;
  embed: Embed;
  pointId?: PointId;
  now?: () => number;
  retiredGraceMs: number;
  orphanGraceMs: number;
}

export function makeQdrantStoreProvider(
  deps: QdrantStoreProviderDeps,
): ISkillsStoreProvider {
  const { client, catalogStore, embed, retiredGraceMs, orphanGraceMs } = deps;
  const pid = deps.pointId ?? pointId;
  const now = deps.now ?? (() => Date.now());

  async function scrollAll(filter: object): Promise<QdrantPoint[]> {
    const out: QdrantPoint[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.scroll(filter, cursor);
      out.push(...page.points);
      cursor = page.next;
    } while (cursor);
    return out;
  }

  function storeFor(group: string): ISkillsStore {
    const readBackend = readBackendFor(client, catalogStore, group);
    return {
      activeSnapshot: readBackend.activeSnapshot,
      release: readBackend.release,
      queryRevision: readBackend.queryRevision,

      async beginGeneration() {
        // Globally-unique id (a process-local counter + ms timestamp can collide
        // across processes — two loaders writing the same id then the CAS-loser's
        // discardGeneration would delete the winner's points). Keep the `group#`
        // prefix (orphan sweep / dropCollection group logic relies on it).
        const generation = `${group}#${randomUUID()}`;
        return { generation };
      },

      async upsert(generation, records, options) {
        const createdAt = now();
        const points: QdrantPoint[] = [];
        for (const record of records) {
          const vector = await embed(record.retrievalText, options);
          points.push({
            id: pid(generation, record.id),
            vector,
            payload: {
              generation,
              group: record.group,
              recordId: record.id,
              content: record.content,
              name: record.name,
              provenance: record.provenance,
              sourceId: record.sourceId,
              createdAt,
            },
          });
        }
        if (points.length > 0) await client.upsertPoints(points);
      },

      async carryForward(generation, sourceIds) {
        const live = activeFromCatalog(await catalogStore.read(), group);
        if (!live) return;
        if (sourceIds.length === 0) return;
        const createdAt = now();
        const carried = await scrollAll({
          generation: live.revision,
          sourceId: [...sourceIds],
        });
        const points: QdrantPoint[] = carried.map((p) => {
          const recordId = String(p.payload.recordId ?? '');
          return {
            id: pid(generation, recordId),
            vector: p.vector,
            payload: { ...p.payload, generation, createdAt },
          };
        });
        if (points.length > 0) await client.upsertPoints(points);
      },

      async discardGeneration(generation) {
        // best-effort immediate cleanup of an inactive in-build generation's points;
        // the age-protected sweep is the durable safety net for crashes.
        // NEVER delete a served generation: if `generation` is named by an ACTIVE
        // (non-tombstone) catalog entry, do nothing (mirror the in-memory store).
        const snap = await catalogStore.read();
        const isActive = snap.entries.some(
          (e) => !e.tombstone && e.generation === generation,
        );
        if (isActive) return;
        await client.deleteByFilter({ generation });
      },
    };
  }

  const provider: ISkillsStoreProvider = {
    forGroup: storeFor,

    async readCatalog(): Promise<CatalogSnapshot> {
      return catalogStore.read();
    },

    async publishCatalog(
      expectedCatalogRevision,
      entries,
    ): Promise<CatalogSnapshot> {
      return catalogStore.casPublish(expectedCatalogRevision, entries, now());
    },

    async dropCollection(group) {
      // retire the group's active entry by republishing without it
      const snap = await catalogStore.read();
      const next = snap.entries.filter((e) => e.collection.group !== group);
      if (next.length !== snap.entries.length) {
        await catalogStore.casPublish(snap.catalogRevision, next, now());
      }
    },

    async sweep(at?: number) {
      const tick = at ?? now();

      // 1) Durable retired-reclaim: delete points of generations past their grace,
      //    then prune them from the durable retired[] (fenced).
      let snap = await catalogStore.read();
      const due = (snap.retired ?? []).filter(
        (r) => r.retiredAt + retiredGraceMs <= tick,
      );
      if (due.length > 0) {
        for (const r of due) {
          await client.deleteByFilter({ generation: r.generation });
        }
        snap = await catalogStore.pruneRetired(
          snap.catalogRevision,
          due.map((r) => r.generation),
        );
      }

      // 2) AGE-PROTECTED orphan reconcile: scroll all points, group by generation,
      //    delete generations that are NEITHER active NOR retired ONLY when their
      //    youngest point is older than orphanGraceMs (never a fresh in-build gen).
      const active = new Set(
        snap.entries.filter((e) => !e.tombstone).map((e) => e.generation),
      );
      const retired = new Set((snap.retired ?? []).map((r) => r.generation));
      // Track the YOUNGEST (max) createdAt per generation: a still-being-written
      // generation has a RECENT youngest point and must be kept — using the oldest
      // (min) point would delete a long in-progress build while it is still writing.
      const maxCreatedAt = new Map<string, number>();
      for (const p of await scrollAll({})) {
        const gen = String(p.payload.generation ?? '');
        if (!gen || active.has(gen) || retired.has(gen)) continue;
        const created = Number(p.payload.createdAt ?? 0);
        const prev = maxCreatedAt.get(gen);
        maxCreatedAt.set(
          gen,
          prev === undefined ? created : Math.max(prev, created),
        );
      }
      for (const [gen, created] of maxCreatedAt) {
        if (created + orphanGraceMs <= tick) {
          await client.deleteByFilter({ generation: gen });
        }
      }
    },

    asBackendProvider(): ISkillsRagBackendProvider {
      // in-process read view (already holds write creds — acceptable here)
      return makeQdrantBackendProvider({
        reader: client,
        catalogReader: catalogStore,
        collection: deps.collection,
      });
    },
  };

  return provider;
}
