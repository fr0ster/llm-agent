import type { CallOptions, ILogger, IMcpClient } from '@mcp-abap-adt/llm-agent';

export interface McpConnectionResult {
  clients: IMcpClient[];
  toolsChanged: boolean;
}

export interface IMcpConnectionStrategy {
  resolve(
    currentClients: IMcpClient[],
    options?: CallOptions,
  ): Promise<McpConnectionResult>;

  dispose?(): Promise<void> | void;
}

export interface McpConnectionConfig {
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  /** HTTP transport headers (e.g. `Accept`, reverse-proxy routing like
   *  `x-sap-destination`). Additive — strategies that ignore it are unaffected. */
  headers?: Record<string, string>;
}

export interface McpClientFactoryResult {
  client: IMcpClient;
  close?: () => Promise<void> | void;
}

export type McpClientFactory = (
  config: McpConnectionConfig,
) => Promise<McpClientFactoryResult>;

export interface ConnectionStrategyOptions {
  skipRevectorize?: boolean;
  logger?: ILogger;
  cooldownMs?: number;
}
