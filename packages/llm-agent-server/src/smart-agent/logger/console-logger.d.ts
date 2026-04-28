import type { ILogger, LogEvent } from '@mcp-abap-adt/llm-agent';
export declare class ConsoleLogger implements ILogger {
    private readonly enabled;
    constructor(enabled?: boolean);
    log(event: LogEvent): void;
}
//# sourceMappingURL=console-logger.d.ts.map