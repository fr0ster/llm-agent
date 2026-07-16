import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import {
  MCPClientWrapper,
  McpClientAdapter,
} from '@mcp-abap-adt/llm-agent-mcp';
import type { SmartServerMcpConfig } from '../smart-server.js';

/**
 * Build a FRESH, UN-CONNECTED set of MCP client wrappers from the resolved
 * `mcp:` config — one call per session so concurrent requests never share an
 * MCP connection (fixes #213). Mirrors `connectMcpClientsFromConfig` but does
 * NOT call `wrapper.connect()` (each wrapper lazily connects on its first
 * `callTool`/`listTools`) and does NOT vectorize (the caller reuses the shared
 * global tool catalog via the builder's provided-clients path).
 *
 * Returns `{ clients, close }`: `close()` disconnects the wrappers this helper
 * created — the only place that owns them. `IMcpClient`/`McpClientAdapter` do
 * not expose `disconnect`; the wrapper does.
 */
export function buildSessionMcpClients(
  mcpCfg: SmartServerMcpConfig | SmartServerMcpConfig[] | undefined | null,
): { clients: IMcpClient[]; close: () => Promise<void> } {
  if (!mcpCfg) return { clients: [], close: async () => {} };
  const list = Array.isArray(mcpCfg) ? mcpCfg : [mcpCfg];
  const wrappers: MCPClientWrapper[] = [];
  const clients: IMcpClient[] = [];
  for (const cfg of list) {
    const wrapper =
      cfg.type === 'stdio'
        ? new MCPClientWrapper({
            transport: 'stdio',
            command: cfg.command,
            args: cfg.args ?? [],
            ...(cfg.timeout !== undefined ? { timeout: cfg.timeout } : {}),
            ...(cfg.toolTimeouts ? { toolTimeouts: cfg.toolTimeouts } : {}),
          })
        : new MCPClientWrapper({
            transport: 'auto',
            url: cfg.url,
            headers: cfg.headers,
            ...(cfg.timeout !== undefined ? { timeout: cfg.timeout } : {}),
            ...(cfg.toolTimeouts ? { toolTimeouts: cfg.toolTimeouts } : {}),
          });
    wrappers.push(wrapper);
    clients.push(new McpClientAdapter(wrapper));
  }
  return {
    clients,
    close: async () => {
      for (const w of wrappers) {
        try {
          await w.disconnect();
        } catch {
          // disconnecting an un-connected / already-closed wrapper is a no-op
        }
      }
    },
  };
}
