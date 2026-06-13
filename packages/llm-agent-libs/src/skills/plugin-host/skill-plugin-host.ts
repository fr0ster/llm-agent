import type {
  CallOptions,
  CatalogEntry,
  CatalogSnapshot,
  IEmbedder,
  ISkillPluginHost,
  ISkillSource,
  ISkillsRagBackendProvider,
  ISkillsRagHandle,
  ISkillsStoreProvider,
  SkillGroupInfo,
  SkillIngestResult,
  SkillLoadResult,
  SkillRecord,
  SkillsManifest,
} from '@mcp-abap-adt/llm-agent';
import { CatalogCasError } from '@mcp-abap-adt/llm-agent'; // value (class), not a type
import { makeCompatibleSkillsRag } from './compatible-skills-rag.js';

/** RECALL-ONLY construction: serves an already-materialised catalog through a READ-ONLY
 *  backend provider (least privilege — no source, no store, no write/reconcile API). The
 *  served collections are materialised out-of-band by a SEPARATE ingest job. */
export interface RecallHostDeps {
  backendProvider: ISkillsRagBackendProvider;
  /** Serving embedder — text query embed + lazy dimension probe. */
  embedder: IEmbedder;
  embeddingSpaceId: string;
  retrievalSchemaVersion: number;
  dimension?: number;
  /** The collections this host serves; each MUST exist in the backend's catalog. */
  serveCollections: string[];
  /** Threaded into makeCompatibleSkillsRag in rag() (Qdrant time-grace). */
  recallTimeoutMs?: number;
}

export type SkillPluginHostDeps = IngestHostDeps | RecallHostDeps;

function isRecallDeps(deps: SkillPluginHostDeps): deps is RecallHostDeps {
  return 'backendProvider' in deps;
}

export interface IngestHostDeps {
  sources: ReadonlyArray<{ id: string; source: ISkillSource }>;
  storeProvider: ISkillsStoreProvider;
  /** Serving embedder (also used to vectorise upserts via the provider). */
  embedder: IEmbedder;
  embeddingSpaceId: string;
  retrievalSchemaVersion: number;
  dimension?: number;
  strict?: boolean;
  /** Default 3. */
  catalogCasMaxAttempts?: number;
  /** Default true; false = an ingest-only job (skips the reload set-guard). */
  servingMode?: boolean;
  /** Threaded into makeCompatibleSkillsRag in rag() (Qdrant time-grace). */
  recallTimeoutMs?: number;
  /** Injected clock for deterministic tests (default Date.now). */
  now?: () => number;
}

/** A desired collection being assembled from the fulfilled sources. */
interface DesiredCollection {
  info: SkillGroupInfo;
  sources: Set<string>;
  records: SkillRecord[];
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export function makeSkillPluginHost(
  deps: SkillPluginHostDeps,
): ISkillPluginHost {
  if (isRecallDeps(deps)) return makeRecallOnlyHost(deps);
  return makeIngestHost(deps);
}

/** RECALL-ONLY host: reads the persisted catalog for `groups()`, validates serveCollections,
 *  eager compat-checks each served collection, and serves via the SAME compat wrapper over
 *  the read-only backend. It opens no generation and writes nothing. */
function makeRecallOnlyHost(deps: RecallHostDeps): ISkillPluginHost {
  const resolvedDimension = deps.dimension;
  let _snapshot: SkillGroupInfo[] = [];

  function rag(group?: string): ISkillsRagHandle {
    let resolved = group;
    if (resolved === undefined) {
      if (_snapshot.length === 1) {
        resolved = _snapshot[0].group;
      } else {
        throw new Error('rag(): must name the group (no unique default)');
      }
    }
    // A group with no active generation simply serves nothing (the compat wrapper returns
    // [] on a null activeSnapshot) — no throw for an unknown/inactive group.
    return makeCompatibleSkillsRag({
      backend: deps.backendProvider.forGroup(resolved),
      embedder: deps.embedder,
      embeddingSpaceId: deps.embeddingSpaceId,
      retrievalSchemaVersion: deps.retrievalSchemaVersion,
      dimension: resolvedDimension,
      recallTimeoutMs: deps.recallTimeoutMs,
    });
  }

  return {
    async load(options?: CallOptions): Promise<SkillLoadResult> {
      const cat = await deps.backendProvider.readCatalog(options);
      // Validate every served collection exists in the persisted catalog (config error).
      for (const g of deps.serveCollections) {
        if (!cat.entries.some((e) => e.collection.group === g)) {
          throw new Error(
            `serveCollections names a collection absent from the catalog: ${g}`,
          );
        }
      }
      // groups() = the SkillGroupInfo of the served collections; register the fixed set.
      _snapshot = deps.serveCollections.map(
        (g) =>
          (cat.entries.find((e) => e.collection.group === g) as CatalogEntry)
            .collection,
      );

      // EAGER fail-fast: probe + compat-check each served collection's active generation.
      // SkillsIncompatibleError propagates (recall-only load aborts on incompatibility).
      for (const g of deps.serveCollections) {
        await rag(g).activeManifest(options);
      }

      return {
        committed: [...deps.serveCollections],
        omitted: [],
        tombstoned: [],
        ok: true,
      };
    },
    groups(): readonly SkillGroupInfo[] {
      return _snapshot;
    },
    rag,
  };
}

function makeIngestHost(deps: IngestHostDeps): ISkillPluginHost {
  const maxAttempts = deps.catalogCasMaxAttempts ?? 3;
  const servingMode = deps.servingMode ?? true;
  const now = deps.now ?? Date.now;

  // Internal host state (closure vars, not deps).
  let _snapshot: SkillGroupInfo[] = [];
  let _registeredSet: Set<string> | undefined;
  let _pendingReclaim: {
    generations: { group: string; generation: string }[];
    tombstonedGroups: string[];
  } = { generations: [], tombstonedGroups: [] };

  // Resolved once before the first build so every manifest is complete.
  let resolvedDimension = deps.dimension;
  async function ensureDimension(options?: CallOptions): Promise<number> {
    if (resolvedDimension === undefined) {
      const probe = await deps.embedder.embed('dimension probe', options);
      resolvedDimension = probe.vector.length;
    }
    return resolvedDimension;
  }

  /** Merge one collection descriptor into the desired map; conflicting descriptions throw. */
  function mergeCollection(
    desired: Map<string, DesiredCollection>,
    c: SkillGroupInfo,
    sourceId: string,
  ): void {
    const existing = desired.get(c.group);
    if (existing) {
      if (existing.info.description !== c.description) {
        throw new Error(
          `conflicting descriptions for collection '${c.group}': ` +
            `'${existing.info.description}' (from ${[...existing.sources].join(',')}) ` +
            `vs '${c.description}' (from ${sourceId})`,
        );
      }
      existing.sources.add(sourceId);
    } else {
      desired.set(c.group, {
        info: c,
        sources: new Set([sourceId]),
        records: [],
      });
    }
  }

  async function attempt(
    manifest: SkillsManifest,
    options: CallOptions | undefined,
  ): Promise<SkillLoadResult> {
    const prior = await deps.storeProvider.readCatalog(options);

    const results = await Promise.allSettled(
      deps.sources.map((s) => s.source.acquire(options)),
    );

    const desired = new Map<string, DesiredCollection>();
    const failedSourceIds: string[] = [];
    for (let i = 0; i < deps.sources.length; i++) {
      const { id } = deps.sources[i];
      const r = results[i];
      if (r.status === 'rejected') {
        failedSourceIds.push(id);
        continue;
      }
      const value = r.value as SkillIngestResult;
      const declaredGroups = new Set(value.collections.map((c) => c.group));
      for (const c of value.collections) mergeCollection(desired, c, id);
      for (const record of value.records) {
        if (!declaredGroups.has(record.group)) {
          throw new Error(
            `source '${id}' record '${record.id}' targets undeclared group '${record.group}'`,
          );
        }
        const dc = desired.get(record.group);
        // mergeCollection guarantees the entry exists (group is declared).
        (dc as DesiredCollection).records.push(record);
        (dc as DesiredCollection).sources.add(id);
      }
    }

    // strict:true → any source failure aborts before any commit.
    if (deps.strict && failedSourceIds.length) {
      throw new Error(
        `strict ingest: source(s) failed: ${failedSourceIds.join(', ')}`,
      );
    }

    // Carry-forward (strict:false): for each prior entry partly owned by a failed source,
    // re-add its collection to desired and mark the failed sourceIds for carryForward.
    const failedSet = new Set(failedSourceIds);
    // group -> sourceIds (owned by a failed source) to carry forward
    const carryForwardByGroup = new Map<string, string[]>();
    for (const e of prior.entries) {
      if (e.tombstone) continue;
      const failedOwners = e.sources.filter((s) => failedSet.has(s));
      if (!failedOwners.length) continue;
      const group = e.collection.group;
      carryForwardByGroup.set(group, [
        ...(carryForwardByGroup.get(group) ?? []),
        ...failedOwners,
      ]);
      if (!desired.has(group)) {
        desired.set(group, {
          info: e.collection,
          sources: new Set(e.sources),
          records: [],
        });
      } else {
        // keep ownership of the carried (failed) sources on the entry
        const dc = desired.get(group) as DesiredCollection;
        for (const s of e.sources) dc.sources.add(s);
      }
    }

    const desiredSet = new Set(desired.keys());

    // SERVING-HOST guard (re-checked on each attempt) — only on a reload.
    if (servingMode && _registeredSet) {
      const activePriorSet = new Set(
        prior.entries
          .filter((e) => !e.tombstone)
          .map((e) => e.collection.group),
      );
      if (
        !setEq(activePriorSet, _registeredSet) ||
        !setEq(desiredSet, _registeredSet)
      ) {
        throw new Error(
          'served collection set changed since first load (reload guard)',
        );
      }
    }

    const built: { group: string; generation: string }[] = [];
    const omitted: { group: string; reason: string }[] = [];
    let committed = false;
    let committedGenerations = new Set<string>();
    try {
      const entries: CatalogEntry[] = [];
      for (const group of desiredSet) {
        const dc = desired.get(group) as DesiredCollection;
        const store = deps.storeProvider.forGroup(group);
        try {
          const { generation } = await store.beginGeneration();
          built.push({ group, generation });
          await store.upsert(generation, dc.records, options);
          const cf = carryForwardByGroup.get(group);
          if (cf?.length) await store.carryForward(generation, cf);
          entries.push({
            collection: dc.info,
            sources: [...dc.sources],
            generation,
            manifest,
          });
        } catch (buildErr) {
          const priorGen = prior.entries.find(
            (e) => e.collection.group === group && !e.tombstone,
          );
          if (priorGen) {
            entries.push({ ...priorGen }); // keep the prior pointer
          } else {
            omitted.push({ group, reason: String(buildErr) }); // OMIT, no prior
          }
        }
      }

      // Tombstone prior active collections not in desiredSet.
      for (const e of prior.entries) {
        if (e.tombstone) continue;
        if (!desiredSet.has(e.collection.group)) {
          entries.push({ ...e, tombstone: true });
        }
      }

      const snap: CatalogSnapshot = await deps.storeProvider.publishCatalog(
        prior.catalogRevision,
        entries,
        options,
      ); // CAS commit — the ONLY activation
      committed = true;

      committedGenerations = new Set(
        entries.filter((e) => !e.tombstone).map((e) => e.generation),
      );

      // Cache the fixed groups() snapshot; register the set on the first load.
      _snapshot = snap.entries
        .filter((e) => !e.tombstone)
        .map((e) => e.collection);
      _registeredSet ??= new Set(_snapshot.map((c) => c.group));

      // SCHEDULE (not now — deferred reclaim) the superseded prior generations
      // + tombstoned groups for reclaim at the NEXT load.
      _pendingReclaim = {
        generations: prior.entries
          .filter((e) => !committedGenerations.has(e.generation))
          .map((e) => ({
            group: e.collection.group,
            generation: e.generation,
          })),
        tombstonedGroups: entries
          .filter((e) => e.tombstone)
          .map((e) => e.collection.group),
      };

      return {
        committed: entries
          .filter((e) => !e.tombstone)
          .map((e) => e.collection.group),
        omitted,
        tombstoned: entries
          .filter((e) => e.tombstone)
          .map((e) => e.collection.group),
        ok: omitted.length === 0,
      };
    } finally {
      // ORPHAN CLEANUP — keyed on the COMMITTED catalog, not on !committed.
      // Discard every generation this attempt built that the committed catalog does
      // NOT name: covers a lost CAS / error / strict abort (committed===false → all
      // built discarded) AND a successful partial commit where a collection fell back
      // to a prior pointer or was omitted. discardGeneration is a no-op for a named gen.
      for (const b of built) {
        if (!committed || !committedGenerations.has(b.generation)) {
          await deps.storeProvider
            .forGroup(b.group)
            .discardGeneration(b.generation);
        }
      }
    }
  }

  return {
    async load(options?: CallOptions): Promise<SkillLoadResult> {
      // RECLAIM at the START of every load. Two disciplines by backend.
      if (deps.storeProvider.sweep) {
        await deps.storeProvider.sweep(now(), options);
      } else {
        for (const g of _pendingReclaim.generations) {
          await deps.storeProvider
            .forGroup(g.group)
            .discardGeneration(g.generation);
        }
        for (const grp of _pendingReclaim.tombstonedGroups) {
          await deps.storeProvider.dropCollection(grp, options);
        }
        _pendingReclaim = { generations: [], tombstonedGroups: [] };
      }

      const manifest: SkillsManifest = {
        embeddingSpaceId: deps.embeddingSpaceId,
        dimension: await ensureDimension(options),
        retrievalSchemaVersion: deps.retrievalSchemaVersion,
      };

      for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
        try {
          return await attempt(manifest, options);
        } catch (e) {
          if (e instanceof CatalogCasError) continue; // built gens already discarded by finally
          throw e;
        }
      }
      throw new CatalogCasError('catalog CAS retries exhausted');
    },

    groups(): readonly SkillGroupInfo[] {
      return _snapshot;
    },

    rag(group?: string): ISkillsRagHandle {
      let resolved = group;
      if (resolved === undefined) {
        if (_snapshot.length === 1) {
          resolved = _snapshot[0].group;
        } else {
          throw new Error('rag(): must name the group (no unique default)');
        }
      }
      // A named group always yields a handle over its backend. A group that is not in
      // the active snapshot (omitted / tombstoned / never built) simply has no active
      // generation, so the compat wrapper serves nothing — no need to throw here.
      return makeCompatibleSkillsRag({
        backend: deps.storeProvider.forGroup(resolved),
        embedder: deps.embedder,
        embeddingSpaceId: deps.embeddingSpaceId,
        retrievalSchemaVersion: deps.retrievalSchemaVersion,
        dimension: resolvedDimension,
        recallTimeoutMs: deps.recallTimeoutMs,
      });
    },
  };
}
