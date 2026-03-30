import type { Message } from '../../types.js';

export interface PendingToolResult {
  toolCallId: string;
  toolName: string;
  text: string;
}

export interface PendingToolCallsEntry {
  assistantMessage: Message;
  promise: Promise<PendingToolResult[]>;
  createdAt: number;
}

export class PendingToolResultsRegistry {
  private readonly sessions = new Map<string, PendingToolCallsEntry>();

  constructor(private readonly ttlMs = 5 * 60 * 1000) {}

  set(sessionId: string, entry: PendingToolCallsEntry): void {
    this.sessions.set(sessionId, entry);
    if (this.sessions.size > 100) this.pruneAll();
  }

  has(sessionId: string, now = Date.now()): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    if (now - entry.createdAt > this.ttlMs) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  async consume(
    sessionId: string,
    now = Date.now(),
  ): Promise<{
    assistantMessage: Message;
    results: PendingToolResult[];
  } | null> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    if (now - entry.createdAt > this.ttlMs) {
      this.sessions.delete(sessionId);
      return null;
    }
    this.sessions.delete(sessionId);
    try {
      const results = await entry.promise;
      return { assistantMessage: entry.assistantMessage, results };
    } catch {
      return { assistantMessage: entry.assistantMessage, results: [] };
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  private pruneAll(now = Date.now()): void {
    for (const [id, entry] of this.sessions.entries()) {
      if (now - entry.createdAt > this.ttlMs) {
        this.sessions.delete(id);
      }
    }
  }
}
