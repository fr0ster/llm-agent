import type { CallOptions, IMcpClient } from '@mcp-abap-adt/llm-agent';
import type { IMcpConnectionStrategy, McpConnectionResult } from '../interfaces/mcp-connection-strategy.js';
export declare class NoopConnectionStrategy implements IMcpConnectionStrategy {
    resolve(currentClients: IMcpClient[], _options?: CallOptions): Promise<McpConnectionResult>;
}
//# sourceMappingURL=noop-connection-strategy.d.ts.map