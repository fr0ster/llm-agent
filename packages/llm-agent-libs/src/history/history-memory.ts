import type { IHistoryMemory } from '@mcp-abap-adt/llm-agent';
import { clearCallerSessionEntries } from '../policy/caller-identity.js';

export class HistoryMemory implements IHistoryMemory {
  private readonly maxSize: number;
  private readonly sessions = new Map<string, string[]>();

  constructor(opts?: { maxSize?: number }) {
    this.maxSize = opts?.maxSize ?? Number.POSITIVE_INFINITY;
  }

  pushRecent(sessionId: string, summary: string): void {
    let entries = this.sessions.get(sessionId);
    if (!entries) {
      entries = [];
      this.sessions.set(sessionId, entries);
    }
    entries.push(summary);
    if (entries.length > this.maxSize) {
      entries.splice(0, entries.length - this.maxSize);
    }
  }

  getRecent(sessionId: string, limit: number): string[] {
    const entries = this.sessions.get(sessionId) ?? [];
    return entries.slice(-limit);
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    clearCallerSessionEntries(this.sessions, sessionId);
  }
}
