import fs from 'node:fs';
import path from 'node:path';

export class SessionLogger {
  private requestDir: string | null = null;
  private fileIndex = 1;

  constructor(
    private readonly baseLogDir: string | null,
    private readonly sessionId: string,
    private readonly traceId: string,
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

  logStep(name: string, data: unknown): void {
    if (!this.requestDir) return;

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
