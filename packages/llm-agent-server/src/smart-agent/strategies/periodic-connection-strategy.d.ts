import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import type { ConnectionStrategyOptions, IMcpConnectionStrategy, McpClientFactory, McpConnectionConfig, McpConnectionResult } from '../interfaces/mcp-connection-strategy.js';
export declare class PeriodicConnectionStrategy implements IMcpConnectionStrategy {
    private readonly _lazy;
    private _cachedResult;
    private _changed;
    private readonly _interval;
    constructor(configs: McpConnectionConfig[], intervalMs: number, options?: ConnectionStrategyOptions, factory?: McpClientFactory);
    private _probe;
    resolve(_currentClients?: IMcpClient[]): Promise<McpConnectionResult>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=periodic-connection-strategy.d.ts.map