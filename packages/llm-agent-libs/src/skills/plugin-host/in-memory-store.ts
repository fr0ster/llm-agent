import type {
  ActiveSnapshot,
  CallOptions,
  CatalogEntry,
  CatalogSnapshot,
  ISkillsRagBackend,
  ISkillsStore,
  ISkillsStoreProvider,
  SkillHit,
  SkillRecord,
} from '@mcp-abap-adt/llm-agent';
import { CatalogCasError } from '@mcp-abap-adt/llm-agent'; // value (class), not a type

interface Row {
  record: SkillRecord;
  vector: number[];
}
type Embed = (text: string, options?: CallOptions) => Promise<number[]>;

export interface IInMemoryStoreProvider extends ISkillsStoreProvider {
  /** TEST SEAM: write pre-vectorised rows into a generation without an embedder. */
  _seed(generation: string, rows: Row[]): Promise<void>;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export function makeInMemoryStoreProvider(
  opts: { embed?: Embed } = {},
): IInMemoryStoreProvider {
  // generations: generationId -> rows
  const gens = new Map<string, Row[]>();
  // EXACT retention (P1.1): a refcount lease per generation + deferred physical delete.
  const leases = new Map<string, number>(); // generation -> active reader count
  const pendingDelete = new Set<string>(); // generations asked to delete while leased
  // catalog
  let catalogRevision = 'c0';
  let entries: CatalogEntry[] = [];
  let genSeq = 0;
  const embed: Embed =
    opts.embed ??
    (async () => {
      throw new Error('no embedder configured');
    });

  const liveGenerationOf = (group: string): string | undefined =>
    entries.find((e) => e.collection.group === group && !e.tombstone)
      ?.generation;
  const isActive = (gen: string) =>
    entries.some((e) => e.generation === gen && !e.tombstone);
  // delete now IF safe (not active, not leased); else mark pending.
  function reclaim(gen: string): void {
    if (isActive(gen)) return; // never delete a served generation
    if ((leases.get(gen) ?? 0) > 0) {
      pendingDelete.add(gen);
      return;
    } // a reader holds it
    gens.delete(gen);
    pendingDelete.delete(gen);
  }

  function backendFor(group: string): ISkillsRagBackend {
    return {
      async activeSnapshot(): Promise<ActiveSnapshot | null> {
        const e = entries.find(
          (x) => x.collection.group === group && !x.tombstone,
        );
        if (!e) return null;
        leases.set(e.generation, (leases.get(e.generation) ?? 0) + 1); // PIN (lease)
        return { revision: e.generation, manifest: e.manifest };
      },
      release(revision: string): void {
        const n = (leases.get(revision) ?? 0) - 1;
        if (n <= 0) {
          leases.delete(revision);
          if (pendingDelete.has(revision)) reclaim(revision); // delete now that no reader holds it
        } else {
          leases.set(revision, n);
        }
      },
      async queryRevision(revision, vector, k): Promise<readonly SkillHit[]> {
        const rows = gens.get(revision); // captured synchronously; lease guaranteed it survives
        if (!rows) throw new Error(`unknown generation: ${revision}`);
        return rows
          .map((r) => ({ record: r.record, score: cosine(vector, r.vector) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, k);
      },
    };
  }

  function storeFor(group: string): ISkillsStore {
    const backend = backendFor(group);
    return {
      ...backend,
      async beginGeneration() {
        const generation = `${group}#g${genSeq++}`;
        gens.set(generation, []);
        return { generation };
      },
      async upsert(generation, records, options) {
        const rows = gens.get(generation) ?? [];
        for (const record of records) {
          rows.push({
            record,
            vector: await embed(record.retrievalText, options),
          });
        }
        gens.set(generation, rows);
      },
      async carryForward(generation, sourceIds) {
        const live = liveGenerationOf(group);
        if (!live) return;
        const src = new Set(sourceIds);
        const carried = (gens.get(live) ?? []).filter((r) =>
          src.has(r.record.sourceId),
        );
        gens.set(generation, [...(gens.get(generation) ?? []), ...carried]);
      },
      async discardGeneration(generation) {
        reclaim(generation); // no-op if active; deferred if leased
      },
    };
  }

  return {
    forGroup: storeFor,
    async _seed(generation, rows) {
      gens.set(generation, [...(gens.get(generation) ?? []), ...rows]);
    },
    async readCatalog(): Promise<CatalogSnapshot> {
      return { catalogRevision, entries: entries.filter((e) => !e.tombstone) };
    },
    async publishCatalog(
      expectedCatalogRevision,
      next,
    ): Promise<CatalogSnapshot> {
      if (expectedCatalogRevision !== catalogRevision) {
        throw new CatalogCasError(
          `stale catalog revision: expected ${expectedCatalogRevision}, active ${catalogRevision}`,
        );
      }
      const nextGens = new Set(
        next.filter((e) => !e.tombstone).map((e) => e.generation),
      );
      const retired = entries
        .filter((e) => !nextGens.has(e.generation))
        .map((e) => ({
          generation: e.generation,
          group: e.collection.group,
          retiredAt: 0,
        })); // in-memory: lease, retiredAt unused
      entries = [...next];
      catalogRevision = `c${Number(catalogRevision.slice(1)) + 1}`; // STORE generates revision
      return {
        catalogRevision,
        entries: entries.filter((e) => !e.tombstone),
        retired,
      };
    },
    async dropCollection(group) {
      // reclaim generations not named by an ACTIVE entry of this group (lease-respecting)
      const activeGen = liveGenerationOf(group);
      for (const gen of [...gens.keys()]) {
        if (gen.startsWith(`${group}#`) && gen !== activeGen) reclaim(gen);
      }
      // remove tombstoned entries of this group from the catalog records
      entries = entries.filter(
        (e) => !(e.collection.group === group && e.tombstone),
      );
    },
    asBackendProvider() {
      // read-only view: only readCatalog + forGroup→backend (no write/reconcile API)
      return {
        readCatalog: this.readCatalog,
        forGroup: (g: string) => backendFor(g),
      };
    },
  };
}
