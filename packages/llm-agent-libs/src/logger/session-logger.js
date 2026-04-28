import fs from 'node:fs';
import path from 'node:path';
export class SessionLogger {
    baseLogDir;
    sessionId;
    traceId;
    requestDir = null;
    fileIndex = 1;
    constructor(baseLogDir, sessionId, traceId) {
        this.baseLogDir = baseLogDir;
        this.sessionId = sessionId;
        this.traceId = traceId;
        if (!this.baseLogDir)
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const sessionPath = path.join(this.baseLogDir, `session_${this.sessionId}`);
        this.requestDir = path.join(sessionPath, `req_${timestamp}_${this.traceId}`);
        try {
            fs.mkdirSync(this.requestDir, { recursive: true });
        }
        catch (err) {
            console.error(`Failed to create log directory: ${this.requestDir}`, err);
            this.requestDir = null;
        }
    }
    logStep(name, data) {
        if (!this.requestDir)
            return;
        const fileName = `${String(this.fileIndex).padStart(2, '0')}_${name}.json`;
        const filePath = path.join(this.requestDir, fileName);
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
            this.fileIndex++;
        }
        catch (err) {
            console.error(`Failed to write log file: ${filePath}`, err);
        }
    }
}
//# sourceMappingURL=session-logger.js.map