/**
 * McpClientAdapter — wraps MCPClientWrapper as IMcpClient.
 */
import { McpError } from '@mcp-abap-adt/llm-agent';

// ---------------------------------------------------------------------------
// Module-private helper
// ---------------------------------------------------------------------------
function withAbort(promise, signal, makeError) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeError());
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(makeError()), {
        once: true,
      });
    }),
  ]);
}
// ---------------------------------------------------------------------------
// McpClientAdapter
// ---------------------------------------------------------------------------
export class McpClientAdapter {
  client;
  toolsCache;
  lastHealthy = true;
  constructor(client) {
    this.client = client;
  }
  async listTools(options) {
    if (this.toolsCache) {
      return { ok: true, value: this.toolsCache };
    }
    try {
      const raw = await withAbort(
        this.client.listTools(),
        options?.signal,
        () => new McpError('Aborted', 'ABORTED'),
      );
      const tools = raw.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? {},
      }));
      this.toolsCache = tools;
      return { ok: true, value: tools };
    } catch (err) {
      if (err instanceof McpError) return { ok: false, error: err };
      return { ok: false, error: new McpError(String(err)) };
    }
  }
  async healthCheck(options) {
    try {
      await withAbort(
        this.client.ping(),
        options?.signal,
        () => new McpError('Aborted', 'ABORTED'),
      );
      // Reconnect detection: unhealthy → healthy means the server restarted
      // and may expose a different tool catalog.
      if (!this.lastHealthy) {
        this.toolsCache = undefined;
      }
      this.lastHealthy = true;
      return { ok: true, value: true };
    } catch (err) {
      this.lastHealthy = false;
      if (err instanceof McpError) return { ok: false, error: err };
      return { ok: false, error: new McpError(String(err)) };
    }
  }
  async callTool(name, args, options) {
    try {
      const result = await withAbort(
        this.client.callTool({
          id: crypto.randomUUID(),
          name,
          arguments: args,
        }),
        options?.signal,
        () => new McpError('Aborted', 'ABORTED'),
      );
      return {
        ok: true,
        value: {
          content:
            typeof (result.error ?? result.result) === 'string' ||
            typeof (result.error ?? result.result) === 'object'
              ? (result.error ?? result.result)
              : String(result.error ?? result.result),
          isError: !!result.error,
        },
      };
    } catch (err) {
      if (err instanceof McpError) return { ok: false, error: err };
      return { ok: false, error: new McpError(String(err)) };
    }
  }
}
//# sourceMappingURL=mcp-client-adapter.js.map
