import type {
  IKnowledgeRagHandle,
  IToolsRagHandle,
  KnowledgeEntry,
  KnowledgeEntryMetadata,
  KnowledgeFilter,
  LlmTool,
} from '@mcp-abap-adt/llm-agent';

/**
 * Persistence + retrieval port for the knowledge blackboard. The server
 * wires a concrete backend (vector store for semantic query + a durable
 * per-session entry log for exhaustive list/rehydrate). The in-memory
 * backend below is the default for stateless deployments and tests.
 */
export interface KnowledgeBackend {
  /** Durably store the full entry (content + metadata) AND index its
   *  content for semantic query. Keyed by sessionId for isolation. */
  put(sessionId: string, entry: KnowledgeEntry): Promise<void>;
  /** Semantic similarity search within a session, relevance-capped by k. */
  semanticQuery(
    sessionId: string,
    text: string,
    k?: number,
  ): Promise<readonly KnowledgeEntry[]>;
  /** Exhaustive durable scan of ALL entries for a session (no relevance
   *  cap). Used by list() and by rehydrate. */
  scan(sessionId: string): Promise<readonly KnowledgeEntry[]>;
  /** Evict ALL entries for a session so a subsequent same-id request does not
   *  rehydrate stale knowledge. Backs DELETE /v1/sessions/:id — without it a
   *  long-lived in-memory backend would retain entries after a session delete. */
  deleteSession(sessionId: string): Promise<void>;
}

/**
 * Per-session blackboard. write() → backend.put (durable + indexed).
 * query() → backend.semanticQuery (k-capped, planner RAG-first). list() →
 * exhaustive scan, metadata-filtered (root finalizer). init() rehydrates
 * the local mirror from the backend so list()/fingerprint() are correct
 * immediately after a resume.
 */
export class KnowledgeRag implements IKnowledgeRagHandle {
  private mirror: KnowledgeEntry[] = [];

  constructor(
    private readonly backend: KnowledgeBackend,
    private readonly sessionId: string,
  ) {}

  /** Call once after construction for a RESUMED session to rehydrate the
   *  local mirror from the durable backend. For a brand-new session it is
   *  a cheap no-op (empty scan). */
  async init(): Promise<void> {
    this.mirror = [...(await this.backend.scan(this.sessionId))];
  }

  async write(entry: {
    content: string;
    metadata: KnowledgeEntryMetadata;
  }): Promise<void> {
    const full: KnowledgeEntry = {
      content: entry.content,
      metadata: entry.metadata,
    };
    await this.backend.put(this.sessionId, full);
    this.mirror.push(full);
  }

  async query(
    text: string,
    opts?: { k?: number; filter?: KnowledgeFilter },
  ): Promise<readonly KnowledgeEntry[]> {
    const hits = await this.backend.semanticQuery(
      this.sessionId,
      text,
      opts?.k,
    );
    const filter = opts?.filter;
    if (!filter) return hits;
    return hits.filter((e) => matches(e.metadata, filter));
  }

  async list(filter: KnowledgeFilter): Promise<readonly KnowledgeEntry[]> {
    // Prefer the durable scan so list() is correct even if the local mirror
    // was never hydrated; fall back to the mirror only if scan is empty and
    // the mirror has entries (write-then-list within one process).
    const durable = await this.backend.scan(this.sessionId);
    const source = durable.length >= this.mirror.length ? durable : this.mirror;
    return source
      .filter((e) => matches(e.metadata, filter))
      .slice()
      .sort((a, b) => a.metadata.createdAt.localeCompare(b.metadata.createdAt));
  }

  fingerprint(): string {
    return `n=${this.mirror.length}`;
  }

  /** Exact-match identity lookup (18.1 dedup): true if a fetched artefact with
   *  this identityKey is already in the store. Uses the durable scan ∪ mirror so
   *  it is correct across a resume and within-process writes. */
  async hasArtifact(identityKey: string): Promise<boolean> {
    if (this.mirror.some((e) => e.metadata.identityKey === identityKey))
      return true;
    const durable = await this.backend.scan(this.sessionId);
    return durable.some((e) => e.metadata.identityKey === identityKey);
  }

  /** The set of fetched-artefact identities (for the planner's "already fetched"
   *  manifest). De-duplicated by identityKey, earliest createdAt kept. */
  async listArtifacts(): Promise<
    ReadonlyArray<{ identityKey: string; toolName?: string; createdAt: string }>
  > {
    const durable = await this.backend.scan(this.sessionId);
    const source = durable.length >= this.mirror.length ? durable : this.mirror;
    const byKey = new Map<
      string,
      { identityKey: string; toolName?: string; createdAt: string }
    >();
    for (const e of source) {
      const k = e.metadata.identityKey;
      if (!k) continue;
      const prev = byKey.get(k);
      if (!prev || e.metadata.createdAt < prev.createdAt)
        byKey.set(k, {
          identityKey: k,
          toolName: e.metadata.toolName,
          createdAt: e.metadata.createdAt,
        });
    }
    return [...byKey.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }
}

function matches(m: KnowledgeEntryMetadata, f: KnowledgeFilter): boolean {
  if (f.traceId && m.traceId !== f.traceId) return false;
  if (f.turnId && m.turnId !== f.turnId) return false;
  if (f.stepperId && m.stepperId !== f.stepperId) return false;
  if (f.parentStepperId && m.parentStepperId !== f.parentStepperId)
    return false;
  if (f.toolName && m.toolName !== f.toolName) return false;
  if (f.artifactType) {
    const set = Array.isArray(f.artifactType)
      ? f.artifactType
      : [f.artifactType];
    if (!set.includes(m.artifactType)) return false;
  }
  return true;
}

/** Default in-memory backend — no persistence across process restart, used
 *  for stateless deployments and tests. (The "RESUME" test reuses the same
 *  instance to simulate a durable backend; a true persistent backend ships
 *  in the server package, see Task 13 note.) */
export class InMemoryKnowledgeBackend implements KnowledgeBackend {
  private readonly bySession = new Map<string, KnowledgeEntry[]>();
  private of(sid: string): KnowledgeEntry[] {
    let a = this.bySession.get(sid);
    if (!a) {
      a = [];
      this.bySession.set(sid, a);
    }
    return a;
  }
  async put(sid: string, entry: KnowledgeEntry) {
    this.of(sid).push(entry);
  }
  async semanticQuery(sid: string, _text: string, k?: number) {
    const a = this.of(sid);
    return k ? a.slice(0, k) : a.slice();
  }
  async scan(sid: string) {
    return this.of(sid).slice();
  }
  async deleteSession(sid: string) {
    this.bySession.delete(sid);
  }
}

/**
 * Thin wrapper around a tools store (query + lookup). Adapts the store's
 * shape to IToolsRagHandle for use in Stepper contexts.
 */
export class ToolsRag implements IToolsRagHandle {
  constructor(
    private readonly store: {
      query(text: string, k?: number): Promise<readonly LlmTool[]>;
      lookup(name: string): LlmTool | undefined;
    },
  ) {}

  async query(text: string, k?: number): Promise<readonly LlmTool[]> {
    return this.store.query(text, k);
  }

  lookup(name: string): LlmTool | undefined {
    return this.store.lookup(name);
  }
}
