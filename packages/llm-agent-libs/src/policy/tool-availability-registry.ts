import type { LlmTool } from '@mcp-abap-adt/llm-agent';
import { clearCallerSessionEntries } from './caller-identity.js';

export interface ToolBlockEntry {
  toolName: string;
  blockedUntil: number;
  reason: string;
}

export class ToolAvailabilityRegistry {
  private readonly sessions = new Map<string, Map<string, ToolBlockEntry>>();

  clear(sessionId: string | undefined): void {
    if (sessionId !== undefined) this.sessions.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    clearCallerSessionEntries(this.sessions, sessionId);
  }

  constructor(private readonly defaultTtlMs = 10 * 60 * 1000) {}

  getBlockedToolNames(
    sessionId: string | undefined,
    now = Date.now(),
  ): Set<string> {
    if (sessionId === undefined) return new Set();
    const blocked = this.sessions.get(sessionId);
    if (!blocked || blocked.size === 0) return new Set();
    this.prune(sessionId, now);
    return new Set(this.sessions.get(sessionId)?.keys() ?? []);
  }

  isBlocked(
    sessionId: string | undefined,
    toolName: string,
    now = Date.now(),
  ): boolean {
    if (sessionId === undefined) return false;
    const blocked = this.sessions.get(sessionId);
    if (!blocked) return false;
    const entry = blocked.get(toolName);
    if (!entry) return false;
    if (entry.blockedUntil <= now) {
      blocked.delete(toolName);
      if (blocked.size === 0) this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  block(
    sessionId: string | undefined,
    toolName: string,
    reason: string,
    ttlMs = this.defaultTtlMs,
    now = Date.now(),
  ): ToolBlockEntry {
    const blockedUntil = now + ttlMs;
    const entry: ToolBlockEntry = { toolName, blockedUntil, reason };
    if (sessionId === undefined) return entry;
    let blocked = this.sessions.get(sessionId);
    if (!blocked) {
      blocked = new Map();
      this.sessions.set(sessionId, blocked);
    }
    blocked.set(toolName, entry);
    return entry;
  }

  filterTools(
    sessionId: string | undefined,
    tools: LlmTool[],
    now = Date.now(),
  ): {
    allowed: LlmTool[];
    blocked: string[];
  } {
    const allowed: LlmTool[] = [];
    const blocked: string[] = [];

    for (const tool of tools) {
      if (this.isBlocked(sessionId, tool.name, now)) {
        blocked.push(tool.name);
      } else {
        allowed.push(tool);
      }
    }

    return { allowed, blocked };
  }

  private prune(sessionId: string, now = Date.now()): void {
    const blocked = this.sessions.get(sessionId);
    if (!blocked) return;
    for (const [name, entry] of blocked.entries()) {
      if (entry.blockedUntil <= now) blocked.delete(name);
    }
    if (blocked.size === 0) this.sessions.delete(sessionId);
  }
}

export function isToolContextUnavailableError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('not available') ||
    normalized.includes('unavailable') ||
    normalized.includes('not found') ||
    normalized.includes('forbidden') ||
    normalized.includes('permission') ||
    normalized.includes('unauthorized') ||
    normalized.includes('disabled') ||
    normalized.includes('not allowed') ||
    normalized.includes('unknown tool')
  );
}
