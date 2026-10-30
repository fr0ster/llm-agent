import { listMetadata, type RagResult } from '@mcp-abap-adt/llm-agent';

export type RecordCacheOptions =
  | false
  | {
      maxEntries?: number;
      maxBytes?: number;
      ttlMs?: number;
    };
interface Entry {
  store: StoreCache;
  id: string;
  record: Pick<RagResult, 'text' | 'metadata'>;
  expires: number;
  bytes: number;
}
export interface ReadLease {
  valid: boolean;
  started: number;
}
function detach(record: Pick<RagResult, 'text' | 'metadata'>): RagResult {
  return {
    text: record.text,
    metadata: structuredClone(listMetadata(record.metadata)),
    score: 1,
  };
}

/** One provider's bounded LRU; store handles share coordination, never record objects. */
export class RecordCache {
  private readonly entries = new Map<string, Entry>();
  private readonly stores = new Map<string, StoreCache>();
  private readonly deletions = new Map<string, number>();
  private bytes = 0;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly ttlMs: number;
  readonly enabled: boolean;
  constructor(options?: RecordCacheOptions) {
    this.enabled = options !== false;
    const config = options === false ? {} : options;
    this.maxEntries = config?.maxEntries ?? 1000;
    this.maxBytes = config?.maxBytes ?? 16 * 1024 * 1024;
    this.ttlMs = config?.ttlMs ?? 5000;
    for (const value of [this.maxEntries, this.maxBytes, this.ttlMs]) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError(
          'recordCache limits must be positive finite safe integers',
        );
    }
  }
  store(identity: string): StoreCache {
    let store = this.stores.get(identity);
    if (!store) {
      store = new StoreCache(this, identity);
      this.stores.set(identity, store);
    }
    if (!this.deletions.has(identity)) {
      store = store.current();
      this.stores.set(identity, store);
    }
    return store;
  }
  beginDeleteStore(identity: string): () => void {
    const store = this.store(identity);
    store.retire();
    this.deletions.set(identity, (this.deletions.get(identity) ?? 0) + 1);
    return () => {
      store.retire();
      const pending = (this.deletions.get(identity) ?? 1) - 1;
      if (pending) this.deletions.set(identity, pending);
      else this.deletions.delete(identity);
    };
  }
  deleteStore(identity: string): void {
    this.stores.get(identity)?.retire();
  }
  close(): void {
    for (const store of this.stores.values()) store.retire();
    this.stores.clear();
  }
  private key(store: StoreCache, id: string): string {
    return JSON.stringify([store.identity, id]);
  }
  drop(store: StoreCache, id?: string): void {
    for (const [key, entry] of this.entries) {
      if (
        entry.store.identity === store.identity &&
        (id === undefined || entry.id === id)
      ) {
        this.entries.delete(key);
        this.bytes -= entry.bytes;
      }
    }
  }
  get(store: StoreCache, id: string): RagResult | undefined {
    const key = this.key(store, id);
    const entry = this.entries.get(key);
    if (!entry || entry.store !== store) return;
    if (Date.now() >= entry.expires) {
      this.drop(store, id);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return detach(entry.record);
  }
  put(store: StoreCache, id: string, record: RagResult, started: number): void {
    if (!this.enabled || Date.now() - started >= this.ttlMs) return;
    try {
      const { text, metadata } = detach(record);
      const copy = { text, metadata };
      const bytes = Buffer.byteLength(JSON.stringify(copy), 'utf8');
      if (bytes > this.maxBytes) return;
      this.drop(store, id);
      this.entries.set(this.key(store, id), {
        store,
        id,
        record: copy,
        bytes,
        expires: started + this.ttlMs,
      });
      this.bytes += bytes;
      while (
        this.entries.size > this.maxEntries ||
        this.bytes > this.maxBytes
      ) {
        const oldest = this.entries.values().next().value;
        if (!oldest) break;
        this.drop(oldest.store, oldest.id);
      }
    } catch {
      // Legacy metadata that is not finite JSON is never admitted.
    }
  }
}

interface StoreCoordination {
  reads: Map<string, Set<ReadLease>>;
  writes: Map<string, number>;
  clearing: number;
}

/** In-flight tokens exist only while reads/writes are active, and are not DB revisions. */
export class StoreCache {
  private retired = false;
  constructor(
    private readonly owner: RecordCache,
    readonly identity: string,
    private readonly coordination: StoreCoordination = {
      reads: new Map(),
      writes: new Map(),
      clearing: 0,
    },
  ) {}
  /** New handles may cache again; old handles retain the same write barriers. */
  current(): StoreCache {
    return this.retired
      ? new StoreCache(this.owner, this.identity, this.coordination)
      : this;
  }
  get(id: string): RagResult | undefined {
    if (
      this.retired ||
      this.coordination.clearing ||
      this.coordination.writes.has(id)
    )
      return;
    return this.owner.get(this, id);
  }
  beginRead(id: string): ReadLease {
    const lease = {
      valid:
        !this.retired &&
        !this.coordination.clearing &&
        !this.coordination.writes.has(id),
      started: Date.now(),
    };
    let active = this.coordination.reads.get(id);
    if (!active) {
      active = new Set();
      this.coordination.reads.set(id, active);
    }
    active.add(lease);
    return lease;
  }
  endRead(id: string, lease: ReadLease, record?: RagResult): void {
    this.coordination.reads.get(id)?.delete(lease);
    if (!this.coordination.reads.get(id)?.size)
      this.coordination.reads.delete(id);
    if (
      record &&
      lease.valid &&
      !this.retired &&
      !this.coordination.clearing &&
      !this.coordination.writes.has(id)
    )
      this.owner.put(this, id, record, lease.started);
  }
  private invalidate(id?: string): void {
    this.owner.drop(this, id);
    for (const [key, leases] of this.coordination.reads) {
      if (id === undefined || key === id)
        for (const lease of leases) lease.valid = false;
    }
  }
  beginWrite(ids: readonly string[]): () => void {
    for (const id of ids) {
      this.invalidate(id);
      this.coordination.writes.set(
        id,
        (this.coordination.writes.get(id) ?? 0) + 1,
      );
    }
    return () => {
      for (const id of ids) {
        this.invalidate(id);
        const remaining = (this.coordination.writes.get(id) ?? 1) - 1;
        if (remaining) this.coordination.writes.set(id, remaining);
        else this.coordination.writes.delete(id);
      }
    };
  }
  beginClear(): () => void {
    this.invalidate();
    this.coordination.clearing++;
    return () => {
      this.invalidate();
      this.coordination.clearing--;
    };
  }
  retire(): void {
    this.retired = true;
    this.invalidate();
  }
}
