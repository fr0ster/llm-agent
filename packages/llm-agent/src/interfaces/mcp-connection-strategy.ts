import type { CallOptions, ILogger, IMcpClient } from '@mcp-abap-adt/llm-agent';
import type { IMcpRequestHeadersStrategy } from './mcp-request-headers-strategy.js';

export interface McpClientDescriptor {
  /** Original configured-array position — stable across reconnect / peer outage. */
  slotIndex: number;
  /** The server's config `name`, if set. */
  label?: string;
}

export interface McpConnectionResult {
  clients: IMcpClient[];
  toolsChanged: boolean;
  /** Per-client stable identity, aligned by index with `clients`. Optional:
   *  strategies that never filter may omit it (array index === config index). */
  clientDescriptors?: readonly McpClientDescriptor[];
  /** Total configured servers (not the active count) — stabilizes the record-key
   *  form under a filtered active set. Optional; defaults to clients.length. */
  configuredSlotCount?: number;
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
  /**
   * Environment for a spawned stdio child. When omitted the SDK falls back to
   * `getDefaultEnvironment()` — a sanitised subset of THIS process's
   * environment — which every child of every caller then shares. Pass the
   * caller's own values here; never in `args`, which are visible in `ps`.
   */
  env?: Record<string, string>;
  /** Stable, human-readable label used as the namespace prefix for this server's colliding tools. */
  name?: string;
  /** HTTP transport headers (e.g. `Accept`, reverse-proxy routing like
   *  `x-sap-destination`). Additive — strategies that ignore it are unaffected. */
  headers?: Record<string, string>;
  /** Consumer-owned strategy contributing additional HTTP headers to MCP requests.
   *  Default = no-op (contributes nothing). A consumer may use this to convey a
   *  "willing to wait longer" hint or other per-request metadata. */
  requestHeadersStrategy?: IMcpRequestHeadersStrategy;
  /** Per-call MCP request timeout in ms (default 3600000 = 1 h — a ceiling meant
   *  not to be reached, since the SDK applies its own 60s when none is given).
   *  A real limit belongs in toolTimeouts, per tool. */
  timeout?: number;
  /** Per-tool MCP request-timeout overrides in ms, keyed by tool name.
   *  Takes precedence over timeout. */
  toolTimeouts?: Record<string, number>;
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
