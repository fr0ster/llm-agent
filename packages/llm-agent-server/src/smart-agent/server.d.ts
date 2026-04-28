import type { SmartAgent } from './agent.js';
export interface SmartAgentServerConfig {
    port?: number;
    host?: string;
    requestTimeoutMs?: number;
}
export interface SmartAgentServerHandle {
    port: number;
    close(): Promise<void>;
}
export declare class SmartAgentServer {
    private readonly agent;
    private readonly config;
    constructor(agent: SmartAgent, config?: SmartAgentServerConfig);
    start(): Promise<SmartAgentServerHandle>;
    private _handleRequest;
    private _readBody;
}
//# sourceMappingURL=server.d.ts.map