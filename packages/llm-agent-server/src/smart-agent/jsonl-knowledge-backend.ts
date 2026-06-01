import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { KnowledgeEntry } from '@mcp-abap-adt/llm-agent';
import type { KnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';

export class JsonlKnowledgeBackend implements KnowledgeBackend {
  constructor(
    private readonly logDir: string,
    /** Optional semantic index for query(); when absent, query falls back to recency. */
    private readonly semantic?: {
      upsert(sid: string, e: KnowledgeEntry): Promise<void>;
      query(
        sid: string,
        text: string,
        k?: number,
      ): Promise<readonly KnowledgeEntry[]>;
    },
  ) {}

  private file(sid: string): string {
    return join(this.logDir, 'sessions', sid, 'knowledge.jsonl');
  }

  async put(sid: string, entry: KnowledgeEntry): Promise<void> {
    const f = this.file(sid);
    await mkdir(dirname(f), { recursive: true });
    await appendFile(f, `${JSON.stringify(entry)}\n`, 'utf8');
    await this.semantic?.upsert(sid, entry);
  }

  async semanticQuery(
    sid: string,
    text: string,
    k?: number,
  ): Promise<readonly KnowledgeEntry[]> {
    if (this.semantic) return this.semantic.query(sid, text, k);
    const all = await this.scan(sid);
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
    // Remove the whole per-session directory (knowledge.jsonl + any siblings).
    await rm(dirname(this.file(sid)), { recursive: true, force: true });
  }
}
