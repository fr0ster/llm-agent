import fs from 'node:fs';
import path from 'node:path';
import type { DebugArea } from './debug-areas.js';

/** Enabled trace areas: 'all' = legacy logDir mode (every step, incl. the
 *  untagged `general` sentinel); a Set = only those areas' tagged steps. */
export type EnabledAreas = 'all' | Set<DebugArea>;

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
    const sessionPath = path.join(this.baseLogDir, `session_${this.sessionId}`);
    this.requestDir = path.join(
      sessionPath,
      `req_${timestamp}_${this.traceId}`,
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

    const fileName = `${String(this.fileIndex).padStart(2, '0')}_${name}.json`;
    const filePath = path.join(this.requestDir, fileName);

    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      this.fileIndex++;
    } catch (err) {
      console.error(`Failed to write log file: ${filePath}`, err);
    }
  }
}
