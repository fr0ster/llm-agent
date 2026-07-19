import fs from 'node:fs';
import path from 'node:path';
import type { DebugArea } from './debug-areas.js';

/** Enabled trace areas: 'all' = legacy logDir mode (every step, incl. the
 *  untagged `general` sentinel); a Set = only those areas' tagged steps. */
export type EnabledAreas = 'all' | Set<DebugArea>;

/**
 * Reduce an untrusted string to a single safe path component.
 *
 * Every dynamic part of a trace path is attacker-influenceable: `name` can
 * carry a model-emitted MCP tool name (`mcp_call_${tc.name}` is logged before
 * the name is resolved against the client map, so it need not be a real
 * tool), and `sessionId`/`traceId` are request-derived. Sanitizing here — at
 * the sink — keeps the guarantee in one place instead of relying on every
 * present and future call site to pre-clean its input.
 *
 * Anything outside `[A-Za-z0-9._-]` becomes `_`, which removes separators,
 * NUL, and drive prefixes in one pass. Runs of dots collapse to `_` too:
 * once separators are gone a literal `..` is inert, but leaving it in a file
 * name makes traces read as though a traversal had happened.
 */
function sanitizePathComponent(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(0, 120);
  if (cleaned === '' || /^\.+$/.test(cleaned)) return fallback;
  return cleaned;
}

export class SessionLogger {
  private requestDir: string | null = null;
  private fileIndex = 1;

  constructor(
    private readonly baseLogDir: string | null,
    private readonly sessionId: string,
    private readonly traceId: string,
    private readonly enabledAreas: EnabledAreas = 'all',
  ) {
    if (!this.baseLogDir) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sessionPath = path.join(
      this.baseLogDir,
      `session_${sanitizePathComponent(this.sessionId, 'unknown')}`,
    );
    this.requestDir = path.join(
      sessionPath,
      `req_${timestamp}_${sanitizePathComponent(this.traceId, 'unknown')}`,
    );

    try {
      fs.mkdirSync(this.requestDir, { recursive: true });
    } catch (err) {
      console.error(`Failed to create log directory: ${this.requestDir}`, err);
      this.requestDir = null;
    }
  }

  /** Write a numbered step file iff the step's area is enabled. `area` omitted =
   *  the internal `general` sentinel (only written under 'all'). */
  logStep(name: string, data: unknown, area?: DebugArea): void {
    if (!this.requestDir) return;
    if (this.enabledAreas !== 'all') {
      // Untagged (general) never writes under a granular set; tagged writes iff on.
      if (area === undefined || !this.enabledAreas.has(area)) return;
    }

    const fileName = `${String(this.fileIndex).padStart(2, '0')}_${sanitizePathComponent(name, 'step')}.json`;
    const filePath = path.join(this.requestDir, fileName);

    // Defence in depth: even with a sanitized component, refuse to write
    // anywhere but the request directory itself.
    if (
      path.dirname(path.resolve(filePath)) !== path.resolve(this.requestDir)
    ) {
      console.error(
        `Refusing to write log file outside trace dir: ${fileName}`,
      );
      return;
    }

    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      this.fileIndex++;
    } catch (err) {
      console.error(`Failed to write log file: ${filePath}`, err);
    }
  }
}
