import type { ILogger, LogEvent } from './types.js';

export class ConsoleLogger implements ILogger {
  private readonly enabled: boolean;

  constructor(enabled?: boolean) {
    this.enabled = enabled ?? process.env.DEBUG_SMART_AGENT === 'true';
  }

  log(event: LogEvent): void {
    if (!this.enabled) return;
    process.stderr.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
    );
  }
}
