/**
 * McpClientAdapter — wraps MCPClientWrapper as IMcpClient.
 */

import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import {
  type CallOptions,
  isMcpUnavailable,
  McpError,
  type McpTool,
  type McpToolResult,
  type Result,
  type SmartAgentError,
} from '@mcp-abap-adt/llm-agent';
import type { MCPClientWrapper } from './client.js';
import { toMcpError } from './error-mapping.js';

// ---------------------------------------------------------------------------
// Module-private helper
// ---------------------------------------------------------------------------

function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  makeError: () => SmartAgentError,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeError());
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(makeError()), {
        once: true,
      });
    }),
  ]);
}

// ---------------------------------------------------------------------------
// McpClientAdapter
// ---------------------------------------------------------------------------

export class McpClientAdapter implements IMcpClient {
  private toolsCache: McpTool[] | undefined;
  private lastHealthy = true;

  constructor(private readonly client: MCPClientWrapper) {}

  async listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>> {
    if (this.toolsCache) {
      return { ok: true, value: this.toolsCache };
    }
    try {
      const raw = await withAbort(
        this.client.listTools(),
        options?.signal,
        () => new McpError('Aborted', 'ABORTED'),
      );

      const tools: McpTool[] = raw.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? {},
      }));

      this.toolsCache = tools;
      return { ok: true, value: tools };
    } catch (err) {
      return { ok: false, error: toMcpError(err) };
    }
  }

  async healthCheck(options?: CallOptions): Promise<Result<boolean, McpError>> {
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
      return { ok: false, error: toMcpError(err) };
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpError>> {
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

      // The wrapper RETURNS { result:null, error } after a failed reconnect (it
      // does not always throw). An availability signature on that returned error
      // must escalate to ok:false — otherwise it is wrapped ok:true/isError and the
      // tool loop feeds "MCP error" back to the LLM instead of failing loud.
      if (result.error !== undefined && result.error !== null) {
        const mapped = toMcpError(result.error);
        if (isMcpUnavailable(mapped)) return { ok: false, error: mapped };
      }

      return {
        ok: true,
        value: {
          content:
            typeof (result.error ?? result.result) === 'string' ||
            typeof (result.error ?? result.result) === 'object'
              ? ((result.error ?? result.result) as
                  | string
                  | Record<string, unknown>)
              : String(result.error ?? result.result),
          isError: !!result.error,
        },
      };
    } catch (err) {
      return { ok: false, error: toMcpError(err) };
    }
  }
}
