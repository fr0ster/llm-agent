import fs from 'node:fs';
import path from 'node:path';
import type { ILogger, LogEvent } from './types.js';

/**
 * Writes each log event to a separate numbered JSON file inside a per-session
 * directory, so files appear in the exact order they were emitted.
 *
 * Layout:
 *   <baseDir>/<YYYY-MM-DDTHH-MM-SS>-<traceId[:8]>/
 *     000_client_request.json
 *     001_llm_request.json
 *     002_llm_response.json
 *     003_client_response.json
 *     ...
 *
 * Events without a traceId field are silently ignored.
 * The session directory is created on the first event for a given traceId.
 */
export class SessionLogger implements ILogger {
  /** Maps traceId → { dir, counter } */
  private readonly sessions = new Map<string, { dir: string; counter: number }>();

  constructor(private readonly baseDir: string) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  log(event: LogEvent): void {
    const traceId = (event as Record<string, unknown>).traceId as string | undefined;
    if (!traceId) return;

    const session = this._getOrCreate(traceId);
    const seq = String(session.counter++).padStart(3, '0');
    const fileName = `${seq}_${event.type}.json`;

    fs.writeFileSync(
      path.join(session.dir, fileName),
      JSON.stringify({ ts: new Date().toISOString(), ...event }, null, 2),
    );

    if (event.type === 'client_response') {
      this.sessions.delete(traceId);
    }
  }

  private _getOrCreate(traceId: string): { dir: string; counter: number } {
    const existing = this.sessions.get(traceId);
    if (existing) return existing;

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(this.baseDir, `${ts}-${traceId.slice(0, 8)}`);
    fs.mkdirSync(dir, { recursive: true });

    const session = { dir, counter: 0 };
    this.sessions.set(traceId, session);
    return session;
  }
}
