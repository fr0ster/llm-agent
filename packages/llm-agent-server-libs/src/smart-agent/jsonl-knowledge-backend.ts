import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  CallOptions,
  KnowledgeEntry,
  KnowledgeFilter,
} from '@mcp-abap-adt/llm-agent';
import {
  type KnowledgeBackend,
  matchesKnowledgeFilter,
} from '@mcp-abap-adt/llm-agent-libs';

/** Injected semantic index (embedder-backed); see makeKnowledgeSemanticIndex. */
interface SemanticIndex {
  upsert(sid: string, e: KnowledgeEntry, options?: CallOptions): Promise<void>;
  query(
    sid: string,
    text: string,
    k?: number,
    filter?: KnowledgeFilter,
    options?: CallOptions,
  ): Promise<readonly KnowledgeEntry[]>;
  deleteSession(sid: string): void;
}

export class JsonlKnowledgeBackend implements KnowledgeBackend {
  constructor(
    private readonly logDir: string,
    /** Optional semantic index; when present query() ranks by similarity and the
     *  index is lazily rehydrated from the durable JSONL on first use. */
    private readonly semantic?: SemanticIndex,
  ) {}

  private file(sid: string): string {
    return join(this.logDir, 'sessions', sid, 'knowledge.jsonl');
  }

  // The in-process index is EMPTY after a restart, but the JSONL log is durable, so
  // it is REBUILT from the durable scan on first use per session. Every
  // index-touching op (build / put / query / delete) runs through run(sid, ...) — a
  // per-session promise chain — so none interleaves; the chain entry is dropped once
  // it drains so the Map cannot grow unbounded. `built` records ONLY successful
  // builds so a failed scan/embed retries rather than caching a rejection.
  private readonly built = new Set<string>();
  private readonly chain = new Map<string, Promise<unknown>>();
  private run<T>(sid: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chain.get(sid) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run regardless of prior outcome
    const tail = next.then(
      () => {},
      () => {},
    );
    this.chain.set(sid, tail);
    void tail.then(() => {
      if (this.chain.get(sid) === tail) this.chain.delete(sid);
    });
    return next;
  }
  private async build(sid: string): Promise<void> {
    if (!this.semantic || this.built.has(sid)) return;
    this.semantic.deleteSession(sid); // clear any partial state → idempotent
    for (const e of await this.scan(sid)) await this.semantic.upsert(sid, e);
    this.built.add(sid); // mark built ONLY on success
  }
  private async append(sid: string, entry: KnowledgeEntry): Promise<void> {
    const f = this.file(sid);
    await mkdir(dirname(f), { recursive: true });
    await appendFile(f, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async put(
    sid: string,
    entry: KnowledgeEntry,
    options?: CallOptions,
  ): Promise<void> {
    if (!this.semantic) {
      await this.append(sid, entry);
      return;
    }
    // ENTIRE put serialized: build FIRST (indexes the durable JSONL BEFORE this
    // append → the new entry is never double-counted by a rebuild scan), THEN
    // append, THEN upsert once. A durable append is the success point: an index
    // upsert failure does NOT rethrow (that would make the caller retry put() and
    // append the same artifact twice); instead mark the session dirty so the next
    // build re-syncs from the durable JSONL.
    await this.run(sid, async () => {
      await this.build(sid);
      await this.append(sid, entry);
      try {
        await this.semantic?.upsert(sid, entry, options);
      } catch (e) {
        this.built.delete(sid);
        if (process.env.DEBUG_CONTROLLER)
          console.error(
            `[jsonl-index] upsert failed (will rebuild lazily): ${String(e)}`,
          );
      }
    });
  }

  async semanticQuery(
    sid: string,
    text: string,
    k?: number,
    filter?: KnowledgeFilter,
    options?: CallOptions,
  ): Promise<readonly KnowledgeEntry[]> {
    if (this.semantic) {
      // build + query in ONE run() so the query reads a consistent snapshot.
      // options is captured in closure and forwarded into the index query so the
      // embedder receives requestLogger for token metering.
      return this.run(sid, async () => {
        await this.build(sid);
        // biome-ignore lint/style/noNonNullAssertion: guarded by the outer check
        return this.semantic!.query(sid, text, k, filter, options);
      });
    }
    let all = await this.scan(sid);
    if (filter)
      all = all.filter((e) => matchesKnowledgeFilter(e.metadata, filter));
    return k ? all.slice(-k) : all;
  }

  async scan(sid: string): Promise<readonly KnowledgeEntry[]> {
    try {
      const raw = await readFile(this.file(sid), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as KnowledgeEntry);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  async deleteSession(sid: string): Promise<void> {
    await this.run(sid, async () => {
      await rm(dirname(this.file(sid)), { recursive: true, force: true });
      this.semantic?.deleteSession(sid);
      this.built.delete(sid);
    });
  }

  get semanticRecallCapable(): boolean {
    return this.semantic !== undefined;
  }
}
