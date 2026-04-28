export class ConsoleLogger {
  enabled;
  constructor(enabled) {
    this.enabled = enabled ?? process.env.DEBUG_SMART_AGENT === 'true';
  }
  log(event) {
    if (!this.enabled) return;
    process.stderr.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
    );
  }
}
//# sourceMappingURL=console-logger.js.map
