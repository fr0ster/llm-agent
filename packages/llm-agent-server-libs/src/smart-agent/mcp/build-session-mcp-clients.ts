import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import {
  MCPClientWrapper,
  McpClientAdapter,
} from '@mcp-abap-adt/llm-agent-mcp';
import type { SmartServerMcpConfig } from '../smart-server.js';

/**
 * Decide whether MCP clients should be isolated per session (#213). Per-session
 * isolation applies ONLY to the YAML `mcp:` path — the connection the server
 * itself owns. Ready-client sources (`_deps.mcpClients` / `cfg.mcpClients` /
 * plugin clients) are consumer/plugin-owned and stay SHARED (`mcpFromYaml`
 * false). `agent.mcpSharedClient: true` opts the YAML path back out to shared.
 */
export function shouldIsolateMcpPerSession(o: {
  mcpFromYaml: boolean;
  mcpSharedClient?: boolean;
}): boolean {
  return o.mcpFromYaml && !o.mcpSharedClient;
}

/**
 * Does the SERVER itself own the MCP connection (the only path eligible for
 * per-session isolation)? True ONLY when there are no ready clients, a YAML
 * `mcp:` block is present, AND no `connectMcp` seam was injected. When a seam is
 * injected it is the SINGLE provisioning point (auth/creds/embedded-stub/custom
 * transport) and the per-session factory — being sync — cannot re-invoke the
 * async seam, so that path stays SHARED. Mirrors the local `yamlBuilderConnect`
 * guard in `smart-server.ts` so `mcpFromYaml` can never bypass the seam (#213).
 */
export function serverOwnsMcpConnection(o: {
  hasReadyClients: boolean;
  hasMcpConfig: boolean;
  mcpSeamInjected: boolean;
}): boolean {
  return !o.hasReadyClients && o.hasMcpConfig && !o.mcpSeamInjected;
}

/** Why per-session MCP isolation is off. Empty when it is on. */
export type McpIsolationDisabledReason =
  | 'mcpSharedClient'
  | 'hasReadyClients'
  | 'mcpSeamInjected'
  | 'noMcpConfig';

/** The resolved per-session MCP isolation decision + the facts behind it. Shape
 *  of the `mcp_isolation` log event (#213 diagnostics). */
export interface McpIsolationReport {
  event: 'mcp_isolation';
  mcpFromYaml: boolean;
  hasReadyClients: boolean;
  hasMcpConfig: boolean;
  mcpSeamInjected: boolean;
  /** Raw config value; `null` when unset, so it is distinguishable from `false`. */
  mcpSharedClient: boolean | null;
  perSession: boolean;
  disabledReasons: McpIsolationDisabledReason[];
}

/**
 * Resolve — ONCE — whether sessions get their own MCP client, and report the
 * facts behind it (#213).
 *
 * This is the SINGLE source of truth: `smart-server.ts` feeds
 * `buildPerSessionMcpClients` from `perSession` AND logs this object, so the
 * diagnostic can never disagree with the wiring. It COMPOSES the two existing
 * gates rather than restating their logic.
 *
 * `disabledReasons` exists so the `config_warning` message can name WHY isolation
 * is off — a deliberate `agent.mcpSharedClient: true` opt-out must be
 * distinguishable from an accidental fallback.
 */
export function describeMcpIsolation(o: {
  hasReadyClients: boolean;
  hasMcpConfig: boolean;
  mcpSeamInjected: boolean;
  mcpSharedClient?: boolean;
}): McpIsolationReport {
  const mcpFromYaml = serverOwnsMcpConnection({
    hasReadyClients: o.hasReadyClients,
    hasMcpConfig: o.hasMcpConfig,
    mcpSeamInjected: o.mcpSeamInjected,
  });
  const perSession = shouldIsolateMcpPerSession({
    mcpFromYaml,
    mcpSharedClient: o.mcpSharedClient,
  });
  const disabledReasons: McpIsolationDisabledReason[] = [];
  if (!perSession) {
    if (o.mcpSharedClient === true) disabledReasons.push('mcpSharedClient');
    if (o.hasReadyClients) disabledReasons.push('hasReadyClients');
    if (o.mcpSeamInjected) disabledReasons.push('mcpSeamInjected');
    if (!o.hasMcpConfig) disabledReasons.push('noMcpConfig');
  }
  return {
    event: 'mcp_isolation',
    mcpFromYaml,
    hasReadyClients: o.hasReadyClients,
    hasMcpConfig: o.hasMcpConfig,
    mcpSeamInjected: o.mcpSeamInjected,
    mcpSharedClient: o.mcpSharedClient ?? null,
    perSession,
    disabledReasons,
  };
}

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
