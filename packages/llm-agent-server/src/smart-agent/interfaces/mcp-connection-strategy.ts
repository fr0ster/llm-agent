import type { CallOptions, IMcpClient } from '@mcp-abap-adt/llm-agent';
import type { ILogger } from '../logger/types.js';

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
