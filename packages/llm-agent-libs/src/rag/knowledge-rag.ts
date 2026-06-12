import type {
  CallOptions,
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
  /** Semantic similarity search within a session, relevance-capped by k. When
   *  `filter` is given it MUST be applied to the candidate set BEFORE the K cap
   *  (so a runId filter is never starved by other runs' artifacts crowding the
   *  cap), preserving the backend's native ranking. `options` is forwarded to
   *  the embedder so recall-time embeds are metered via `options.requestLogger`. */
  semanticQuery(
    sessionId: string,
    text: string,
    k?: number,
    filter?: KnowledgeFilter,
    options?: CallOptions,
  ): Promise<readonly KnowledgeEntry[]>;
  /** Exhaustive durable scan of ALL entries for a session (no relevance
   *  cap). Used by list() and by rehydrate. */
  scan(sessionId: string): Promise<readonly KnowledgeEntry[]>;
  /** Evict ALL entries for a session so a subsequent same-id request does not
   *  rehydrate stale knowledge. Backs DELETE /v1/sessions/:id — without it a
   *  long-lived in-memory backend would retain entries after a session delete. */
  deleteSession(sessionId: string): Promise<void>;
  /** True iff the backend supports embedding-based semantic recall (an index is
   *  attached). The controller asserts this before wiring run-scoped recall. */
  readonly semanticRecallCapable?: boolean;
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
    opts?: { k?: number; filter?: KnowledgeFilter; options?: CallOptions },
  ): Promise<readonly KnowledgeEntry[]> {
    // Pass the filter AND options INTO semanticQuery so the backend applies the
    // filter PRE-cap (preserving its native ranking) and the embedder receives
    // options (for requestLogger metering); a defensive post-filter is harmless.
    const hits = await this.backend.semanticQuery(
      this.sessionId,
      text,
      opts?.k,
      opts?.filter,
      opts?.options,
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
      // Keep the LATEST write per identity (read-after-write: "the last result
      // is read"), so a re-fetched/updated artefact supersedes the earlier one.
      if (!prev || e.metadata.createdAt >= prev.createdAt)
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

  /** Content of the stored artefact with this identityKey, for cross-step reuse.
   *  Returns the LATEST write (read-after-write: "the last result is read"), so a
   *  re-fetched/updated artefact supersedes an earlier one. Undefined if absent. */
  async getArtifact(identityKey: string): Promise<string | undefined> {
    const findLast = (arr: readonly KnowledgeEntry[]) => {
      for (let i = arr.length - 1; i >= 0; i--)
        if (arr[i].metadata.identityKey === identityKey) return arr[i].content;
      return undefined;
    };
    // Prefer the durable scan when it is at least as complete as the mirror
    // (it carries cross-process writes); else the in-process mirror.
    const durable = await this.backend.scan(this.sessionId);
    const source = durable.length >= this.mirror.length ? durable : this.mirror;
    return findLast(source);
  }
}

export function matches(
  m: KnowledgeEntryMetadata,
  f: KnowledgeFilter,
): boolean {
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
  if (f.runId !== undefined && m.runId !== f.runId) return false;
  if (f.seq !== undefined && m.seq !== f.seq) return false;
  if (f.attempt !== undefined && m.attempt !== f.attempt) return false;
  if (f.status !== undefined && m.status !== f.status) return false;
  return true;
}

/** Default in-memory backend — no persistence across process restart, used
 *  for stateless deployments and tests. (The "RESUME" test reuses the same
 *  instance to simulate a durable backend; a true persistent backend ships
 *  in the server package, see Task 13 note.) */
export class InMemoryKnowledgeBackend implements KnowledgeBackend {
  private readonly bySession = new Map<string, KnowledgeEntry[]>();
  /** Optional embedder-backed index; when present, semanticQuery delegates to it
   *  (real ranking) — else filter + insertion order (pure unit tests). */
  constructor(
    private readonly semantic?: {
      upsert(sid: string, e: KnowledgeEntry): Promise<void>;
      query(
        sid: string,
        text: string,
        k?: number,
        filter?: KnowledgeFilter,
        options?: CallOptions,
      ): Promise<readonly KnowledgeEntry[]>;
      deleteSession(sid: string): void;
    },
  ) {}
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
    await this.semantic?.upsert(sid, entry);
  }
  async semanticQuery(
    sid: string,
    text: string,
    k?: number,
    filter?: KnowledgeFilter,
    options?: CallOptions,
  ) {
    if (this.semantic)
      return this.semantic.query(sid, text, k, filter, options);
    let a = this.of(sid);
    if (filter) a = a.filter((e) => matches(e.metadata, filter));
    return k ? a.slice(0, k) : a.slice();
  }
  async scan(sid: string) {
    return this.of(sid).slice();
  }
  async deleteSession(sid: string) {
    this.bySession.delete(sid);
    this.semantic?.deleteSession(sid);
  }
  get semanticRecallCapable(): boolean {
    return this.semantic !== undefined;
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
