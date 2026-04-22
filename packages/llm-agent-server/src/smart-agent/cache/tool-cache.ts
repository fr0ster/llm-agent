import { createHash } from 'node:crypto';
import type { McpToolResult } from '@mcp-abap-adt/llm-agent';
import type { IToolCache } from './types.js';

interface CacheEntry {
  result: McpToolResult;
  expiresAt: number;
}

export class ToolCache implements IToolCache {
  private readonly map = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? 300_000;
  }

  get(
    toolName: string,
    args: Record<string, unknown>,
  ): McpToolResult | undefined {
    const key = this._key(toolName, args);
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.result;
  }

  set(
    toolName: string,
    args: Record<string, unknown>,
    result: McpToolResult,
  ): void {
    const key = this._key(toolName, args);
    this.map.set(key, { result, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.map.clear();
  }

  private _key(toolName: string, args: Record<string, unknown>): string {
    const sorted = JSON.stringify(args, Object.keys(args).sort());
    const hash = createHash('sha256').update(sorted).digest('hex');
    return `${toolName}:${hash}`;
  }
}
