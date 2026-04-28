import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import type { ConnectionStrategyOptions, IMcpConnectionStrategy, McpClientFactory, McpConnectionConfig, McpConnectionResult } from '../interfaces/mcp-connection-strategy.js';
export declare class LazyConnectionStrategy implements IMcpConnectionStrategy {
    private readonly _slots;
    private readonly _skipRevectorize;
    private readonly _cooldownMs;
    private readonly _factory;
    private _resolving;
    constructor(configs: McpConnectionConfig[], options?: ConnectionStrategyOptions, factory?: McpClientFactory);
    resolve(_currentClients?: IMcpClient[]): Promise<McpConnectionResult>;
    private _doResolve;
    private _checkHealth;
    dispose(): Promise<void>;
}
//# sourceMappingURL=lazy-connection-strategy.d.ts.map