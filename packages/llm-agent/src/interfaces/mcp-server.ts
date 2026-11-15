import type { IMcpClient } from './mcp-client.js';
import type { McpClientDescriptor } from './mcp-connection-strategy.js';

/**
 * An MCP server this process owns the lifetime of: a spawned stdio child, a
 * held HTTP connection, or an in-process embedded server.
 *
 * Using a server is `IMcpClient`; starting and stopping one is this. The
 * credential a particular target needs is demanded by the implementation's own
 * constructor, typed for that target — the framework never sees it.
 *
 * Reconnection is NOT here: `IMcpConnectionStrategy` owns outage handling.
 * `start()` is called once per instance; an implementation that cannot be
 * restarted after `stop()` throws.
 */
export interface IMcpServer {
  /**
   * Stable identity for tool namespacing, forwarded by wrappers. A non-empty
   * label is required when building with multiple servers. A single server
   * without a descriptor uses prefix s0.
   */
  readonly descriptor?: McpClientDescriptor;
  start(): Promise<IMcpClient>;
  stop(): Promise<void>;
}
