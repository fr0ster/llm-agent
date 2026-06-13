import type { CallOptions } from './types.js';

export interface SkillHit {
  record: SkillRecord;
  score: number;
} // cosine similarity in [0,1]

export interface SkillRecord {
  id: string; // LOGICAL stable id "<source>:<plugin>@<version>/<skill>#<chunkIx>" (deterministic)
  sourceId: string; // stable, version-independent config source id (reconciliation/carry-forward key)
  group: string; // collection the STRATEGY placed this record in (conflict-isolation unit)
  name: string; // "<plugin>/<skill>" (+ "#<heading>" for a chunk) — human label
  retrievalText: string; // the EMBEDDED surface — distinct per chunk (description + heading + chunk content)
  content: string; // the chunk body injected verbatim into the LLM context
  provenance: string; // versioned "<plugin>@<version>/<skill>#<heading>"
}

export interface SkillsEmbeddingDescriptor {
  embeddingSpaceId: string; // stable id of the actual vector space (deployment/adapter-supplied)
  dimension: number; // vector length
  retrievalSchemaVersion: number; // host code constant: retrievalText composition + chunking contract version
}
export type SkillsManifest = SkillsEmbeddingDescriptor; // what an active generation carries

export interface ActiveSnapshot {
  revision: string;
  manifest: SkillsManifest;
} // revision = serving generation id

export interface SkillGroupInfo {
  group: string;
  description: string;
  collection: string;
}

export interface CatalogEntry {
  collection: SkillGroupInfo;
  sources: readonly string[]; // ownership: sourceIds contributing here
  generation: string; // THE serving generation pointer
  manifest: SkillsManifest;
  tombstone?: boolean; // published-but-being-reclaimed (not served)
}

export interface RetiredGeneration {
  generation: string;
  group: string;
  retiredAt: number;
} // ms epoch

export interface CatalogSnapshot {
  catalogRevision: string;
  entries: readonly CatalogEntry[]; // active (non-tombstone) entries are what groups() shows
  retired?: readonly RetiredGeneration[]; // committed atomically with the pointer swap
}

export interface ISkillsCatalog {
  readCatalog(options?: CallOptions): Promise<CatalogSnapshot>;
}

export interface ISkillsRagBackend {
  activeSnapshot(): Promise<ActiveSnapshot | null>; // pins (lease) the resolved generation when non-null
  release?(revision: string): void; // release a lease (refcount--); no-op on time-grace backends
  queryRevision(
    revision: string,
    vector: number[],
    k: number,
    options?: CallOptions,
  ): Promise<readonly SkillHit[]>;
}

export interface ISkillsRagHandle {
  query(
    text: string,
    opts: { k: number; threshold?: number },
    options?: CallOptions,
  ): Promise<readonly SkillHit[]>;
  activeManifest(options?: CallOptions): Promise<ActiveSnapshot | null>; // eager fail-fast; THROWS on incompatibility
}

export interface ISkillsStore extends ISkillsRagBackend {
  beginGeneration(): Promise<{ generation: string }>; // fresh INACTIVE namespace
  upsert(
    generation: string,
    records: readonly SkillRecord[],
    options?: CallOptions,
  ): Promise<void>;
  carryForward(generation: string, sourceIds: readonly string[]): Promise<void>;
  discardGeneration(generation: string): Promise<void>; // idempotent; never deletes an active-catalog generation
}

export interface ISkillsRagBackendProvider extends ISkillsCatalog {
  forGroup(group: string): ISkillsRagBackend;
}

export interface ISkillsStoreProvider extends ISkillsCatalog {
  forGroup(group: string): ISkillsStore;
  // SINGLE fenced commit: the store generates the next revision, stamps retiredAt on dropped
  // generations, returns the committed snapshot; throws CatalogCasError on a stale expected revision.
  publishCatalog(
    expectedCatalogRevision: string,
    entries: readonly CatalogEntry[],
    options?: CallOptions,
  ): Promise<CatalogSnapshot>;
  dropCollection(group: string, options?: CallOptions): Promise<void>;
  sweep?(now: number, options?: CallOptions): Promise<void>; // optional durable crash-resumable reclaim
  asBackendProvider(): ISkillsRagBackendProvider; // read-only view (no write/reconcile API)
}

export interface ISkillSource {
  acquire(options?: CallOptions): Promise<SkillIngestResult>;
}
export interface SkillIngestResult {
  collections: readonly SkillGroupInfo[]; // authoritative desired catalog (+ descriptions)
  records: readonly SkillRecord[]; // each record.group must be in collections[].group
}

export interface SkillLoadResult {
  committed: readonly string[];
  omitted: readonly { group: string; reason: string }[];
  tombstoned: readonly string[];
  ok: boolean;
}

export interface ISkillPluginHost {
  load(options?: CallOptions): Promise<SkillLoadResult>;
  groups(): readonly SkillGroupInfo[]; // sync, fixed-at-load snapshot
  rag(group?: string): ISkillsRagHandle;
}

/** Thrown by publishCatalog when the fenced CAS loses (a concurrent loader committed first). */
export class CatalogCasError extends Error {}
/** Thrown by ISkillsRagHandle.activeManifest on a serving-descriptor ↔ manifest mismatch (eager fail-fast). */
export class SkillsIncompatibleError extends Error {}
