/**
 * McpClientAdapter — wraps MCPClientWrapper as IMcpClient.
 */

import type { MCPClientWrapper } from '../../mcp/client.js';
import type { IMcpClient } from '../interfaces/mcp-client.js';
import {
  type CallOptions,
  McpError,
  type McpTool,
  type McpToolResult,
  type Result,
  type SmartAgentError,
} from '../interfaces/types.js';

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
  constructor(private readonly client: MCPClientWrapper) {}

  async listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>> {
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

      return { ok: true, value: tools };
    } catch (err) {
      if (err instanceof McpError) return { ok: false, error: err };
      return { ok: false, error: new McpError(String(err)) };
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
      if (err instanceof McpError) return { ok: false, error: err };
      return { ok: false, error: new McpError(String(err)) };
    }
  }
}
