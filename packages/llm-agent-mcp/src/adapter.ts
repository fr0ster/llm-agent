/**
 * McpClientAdapter — wraps MCPClientWrapper as IMcpClient.
 */

import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import {
  type CallOptions,
  type McpContentBlock,
  McpError,
  type McpTool,
  type McpToolResult,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import type { MCPClientWrapper } from './client.js';
import { toMcpError } from './error-mapping.js';
import { withAbort } from './with-abort.js';

// ---------------------------------------------------------------------------
// Module-private helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// McpClientAdapter
// ---------------------------------------------------------------------------

export class McpClientAdapter implements IMcpClient {
  private toolsCache: McpTool[] | undefined;
  private lastHealthy = true;

  constructor(private readonly client: MCPClientWrapper) {}

  async listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>> {
    // The cache answers only while the last health result was good (spec
    // §10.5.3 M2). After a failed probe or call, ask the server — which fails
    // with its mapped code when it is down.
    if (this.toolsCache && this.lastHealthy) {
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
      this.lastHealthy = true;
      return { ok: true, value: tools };
    } catch (err) {
      const error = toMcpError(err);
      this._markFailure(error);
      return { ok: false, error };
    }
  }

  /** A failed call that is not the caller's abort marks the server unhealthy,
   *  so the tools cache no longer answers for it. */
  private _markFailure(error: McpError): void {
    if (error.code !== 'ABORTED') this.lastHealthy = false;
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
        // The signal goes INTO the call, not only around it. Racing it outside
        // answers the caller and leaves the tool running — on an ABAP write
        // chain, with its lock still held.
        this.client.callTool(
          {
            id: crypto.randomUUID(),
            name,
            arguments: args,
          },
          options?.signal,
        ),
        options?.signal,
        () => new McpError('Aborted', 'ABORTED'),
      );

      // A RETURNED { error } is normally TOOL-level feedback (the tool ran and
      // failed) → ok:true/isError below. The ONE exception is a connection-loss
      // signature the wrapper may still return instead of throw (legacy/embedded
      // paths): escalate ONLY those to ok:false. We deliberately do NOT escalate
      // timeout/HTTP/ambiguous returned errors here — a tool's own "request timed
      // out" / "forbidden" message is domain feedback, not an MCP outage; only the
      // THROWN transport path (catch below) treats those as unavailable.
      if (result.error !== undefined && result.error !== null) {
        const mapped = toMcpError(result.error);
        if (
          mapped.code === 'MCP_NOT_CONNECTED' ||
          mapped.code === 'MCP_NO_RESPONSE'
        ) {
          this._markFailure(mapped);
          return { ok: false, error: mapped };
        }
      }

      return {
        ok: true,
        value: {
          content:
            typeof (result.error ?? result.result) === 'string' ||
            typeof (result.error ?? result.result) === 'object'
              ? ((result.error ?? result.result) as
                  | string
                  | Record<string, unknown>
                  | McpContentBlock[])
              : String(result.error ?? result.result),
          // A tool-level failure is signalled EITHER by a returned `error`
          // field OR by the MCP CallToolResult's own `isError` (a tool that ran
          // and failed, e.g. a locked SAP object). Reading only `error` dropped
          // the latter — an executor then retried an unrecoverable failure
          // forever (#213/#231).
          isError: !!result.error || result.isError === true,
        },
      };
    } catch (err) {
      const error = toMcpError(err);
      this._markFailure(error);
      return { ok: false, error };
    }
  }
}
