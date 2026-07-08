import type { CallOptions, ILogger, IMcpClient } from '@mcp-abap-adt/llm-agent';
import type { IMcpRequestHeadersStrategy } from './mcp-request-headers-strategy.js';

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
  /** Consumer-owned strategy contributing additional HTTP headers to MCP requests.
   *  Default = no-op (contributes nothing). A consumer may use this to convey a
   *  "willing to wait longer" hint or other per-request metadata. */
  requestHeadersStrategy?: IMcpRequestHeadersStrategy;
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
