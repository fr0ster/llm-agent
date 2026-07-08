/**
 * MCP Client Wrapper
 *
 * Wraps the MCP SDK client to provide a simpler interface for the agent
 */

import type { ToolCall, ToolResult } from '@mcp-abap-adt/llm-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { toMcpError } from './error-mapping.js';

/** MCP self-governs its own request timeout. The SDK forces a numeric
 *  per-request timeout (~60s default) with no documented disable, so we pass
 *  an effectively-unbounded value (24h) + resetTimeoutOnProgress. Cancellation
 *  still comes from the agent's AbortSignal via McpClientAdapter.callTool. */
const MCP_NO_CLIENT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

type McpToolDef = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type EmbeddedServerInstance = {
  server?: unknown;
};

export type TransportType =
  | 'stdio'
  | 'sse'
  | 'stream-http'
  | 'auto'
  | 'embedded';

export interface MCPClientConfig {
  /**
   * Transport type:
   * - 'stdio': Standard input/output (for local processes)
   * - 'sse': Server-Sent Events (GET endpoint)
   * - 'stream-http': Streamable HTTP (POST endpoint, bidirectional NDJSON)
   * - 'auto': Automatically detect from URL (defaults to 'stream-http' for HTTP URLs)
   * - 'embedded': Direct MCP server instance (same process, no transport)
   *
   * If URL is provided and transport is 'auto', it will be detected automatically:
   * - URLs containing '/sse' or ending with '/sse' -> 'sse'
   * - URLs containing '/stream/http' or '/http' -> 'stream-http'
   * - Otherwise defaults to 'stream-http'
   */
  transport?: TransportType;

  /**
   * For embedded mode: Direct MCP server instance
   * Use this when MCP server runs in the same process (e.g., imported as submodule)
   * The server instance must have:
   * - server.setRequestHandler() method for ListToolsRequestSchema and CallToolRequestSchema
   * - Or provide tools list and tool call handler directly
   */
  serverInstance?: EmbeddedServerInstance;

  /**
   * For embedded mode: Direct access to tools registry
   * If provided, listTools() will use this instead of calling server
   */
  toolsRegistry?: {
    getAllTools: () => McpToolDef[];
  };

  /**
   * For embedded mode: Direct tool call handler
   * If provided, callTool() will use this instead of calling server
   */
  toolCallHandler?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;

  /**
   * Direct tools list provider (DI)
   * Use this to supply tools without relying on MCP transport details.
   */
  listToolsHandler?: () => Promise<McpToolDef[]>;

  /**
   * Direct tool call provider (DI)
   * Use this to supply tool execution without relying on MCP transport details.
   */
  callToolHandler?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;

  /**
   * For stdio: command and args to execute
   */
  command?: string;
  args?: string[];

  /**
   * For HTTP transports: URL endpoint
   * Examples:
   * - 'http://localhost:4004/mcp/stream/sse' -> SSE transport
   * - 'http://localhost:4004/mcp/stream/http' -> Streamable HTTP transport
   */
  url?: string;

  /**
   * Session ID for HTTP transports (optional, will be generated if not provided)
   * For Streamable HTTP: first request should omit this, subsequent requests should include it
   */
  sessionId?: string;

  /**
   * HTTP headers for authentication and configuration
   */
  headers?: Record<string, string>;

  /** @deprecated No longer used. MCP self-governs its request timeouts; this field is retained only for backward compatibility and has no effect. */
  timeout?: number;
}

/**
 * Build StreamableHTTPClientTransport options from an already-resolved sessionId.
 * The caller MUST resolve the session id (via `_sessionForConnect()`) before calling
 * this helper — the helper intentionally does NOT read `config.sessionId` so that live
 * server-assigned ids always survive reconnect.
 *
 * No `signal` is set: MCP self-governs its request timeouts via the SDK's own mechanism.
 */
export function buildHttpTransportOptions(opts: {
  headers?: Record<string, string>;
  sessionId?: string;
}): { sessionId?: string; requestInit: { headers: Record<string, string> } } {
  return {
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    requestInit: {
      headers: {
        Accept: 'application/json, text/event-stream',
        ...opts.headers,
      },
    },
  };
}

export class MCPClientWrapper {
  private client: Client | null = null;
  private config: MCPClientConfig;
  private tools: McpToolDef[] = [];
  private detectedTransport: TransportType;
  private sessionId?: string;

  constructor(config: MCPClientConfig) {
    this.config = config;
    this.detectedTransport = this.detectTransport();
  }

  /**
   * Detect transport type from config
   */
  private detectTransport(): TransportType {
    // If transport is explicitly set and not 'auto', use it
    if (this.config.transport && this.config.transport !== 'auto') {
      return this.config.transport;
    }

    // If direct handlers or server instance are provided, use embedded mode
    if (
      this.config.listToolsHandler ||
      this.config.callToolHandler ||
      this.config.serverInstance
    ) {
      return 'embedded';
    }

    // If URL is provided, try to detect from URL
    if (this.config.url) {
      const url = this.config.url.toLowerCase();
      if (url.includes('/sse') || url.endsWith('/sse')) {
        return 'sse';
      }
      if (url.includes('/stream/http') || url.includes('/http')) {
        return 'stream-http';
      }
      // Default for HTTP URLs
      if (url.startsWith('http://') || url.startsWith('https://')) {
        return 'stream-http';
      }
    }

    // If command is provided, assume stdio
    if (this.config.command) {
      return 'stdio';
    }

    // Default fallback
    throw new Error(
      'Cannot determine transport type. Please provide either:\n' +
        '  - transport: "embedded" with serverInstance\n' +
        '  - transport: "stdio" with command\n' +
        '  - transport: "sse" or "stream-http" with url\n' +
        '  - url (will auto-detect transport)',
    );
  }

  /**
   * Initialize MCP client connection
   */
  async connect(): Promise<void> {
    const transport = this.detectedTransport;

    if (transport === 'embedded') {
      const hasDirectTools =
        this.config.listToolsHandler || this.config.toolsRegistry;
      // Embedded mode - allow direct handlers without serverInstance
      if (!this.config.serverInstance && !hasDirectTools) {
        throw new Error(
          'serverInstance or toolsRegistry/listToolsHandler is required for embedded transport',
        );
      }

      // If tools registry is provided, use it directly
      if (this.config.listToolsHandler) {
        this.tools = await this.config.listToolsHandler();
      } else if (this.config.toolsRegistry) {
        this.tools = this.config.toolsRegistry.getAllTools();
      } else {
        // Fallback: try to get from server instance if it has a method
        if (this.config.serverInstance?.server) {
          // Try to simulate ListToolsRequest
          try {
            // MCP Server has request handlers, but we need to call them directly
            throw new Error(
              'Direct server.listTools() not supported, use toolsRegistry',
            );
          } catch (_err) {
            throw new Error(
              'Cannot get tools list in embedded mode. Provide toolsRegistry.',
            );
          }
        } else {
          throw new Error(
            'Cannot get tools list in embedded mode. Provide toolsRegistry.',
          );
        }
      }

      // No need to connect in embedded mode - server is already in process
      return;
    } else if (transport === 'stdio') {
      if (!this.config.command) {
        throw new Error('Command is required for stdio transport');
      }

      const stdioTransport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args || [],
      });

      this.client = new Client(
        {
          name: 'llm-agent',
          version: '0.1.0',
        },
        {
          capabilities: {},
        },
      );

      await this.client.connect(stdioTransport);

      // List available tools
      const toolsResponse = await this.client.listTools();
      this.tools = toolsResponse.tools || [];
    } else if (transport === 'sse' || transport === 'stream-http') {
      if (!this.config.url) {
        throw new Error('URL is required for HTTP transports');
      }

      // Use StreamableHTTPClientTransport for both SSE and stream-http
      // The SDK handles the protocol differences internally
      const httpTransport = new StreamableHTTPClientTransport(
        new URL(this.config.url),
        buildHttpTransportOptions({
          headers: this.config.headers,
          sessionId: this._sessionForConnect(),
        }),
      );

      this.client = new Client(
        {
          name: 'llm-agent',
          version: '0.1.0',
        },
        {
          capabilities: {},
        },
      );

      await this.client.connect(httpTransport);

      // Store session ID if provided by transport
      if (httpTransport.sessionId) {
        this.sessionId = httpTransport.sessionId;
      }

      // List available tools
      const toolsResponse = await this.client.listTools();
      this.tools = toolsResponse.tools || [];
    } else {
      throw new Error(`Unsupported transport type: ${transport}`);
    }
  }

  /**
   * Get detected transport type
   */
  getTransport(): TransportType {
    return this.detectedTransport;
  }

  /**
   * Get current session ID (for HTTP transports)
   */
  getSessionId(): string | undefined {
    return this.sessionId || this.config.sessionId;
  }

  /**
   * Session id to (re)connect with: prefer the live server-assigned id so a
   * reconnect RESUMES the same session (no lost session state / tool result);
   * fall back to the configured id on a first connect.
   */
  private _sessionForConnect(): string | undefined {
    return this.sessionId ?? this.config.sessionId;
  }

  /**
   * Get list of available tools
   */
  async listTools(): Promise<McpToolDef[]> {
    // For embedded mode, tools are already loaded in connect()
    if (this.detectedTransport === 'embedded') {
      return this.tools;
    }

    const performList = async () => {
      if (!this.client) {
        await this.connect();
      }
      const response = await this.client?.listTools();
      if (!response) {
        throw new Error('MCP listTools returned no response');
      }
      this.tools = response.tools || [];
      return this.tools;
    };

    try {
      return await performList();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      try {
        console.warn(
          `MCP listTools failed, attempting reconnect: ${errorMessage}`,
        );
        await this.disconnect();
        await this.connect();
        return await performList();
      } catch (_retryError) {
        return this.tools; // Return cached tools if reconnect fails
      }
    }
  }

  /**
   * Execute a tool call
   */
  async callTool(toolCall: ToolCall): Promise<ToolResult> {
    // For embedded mode, use direct handler or server instance
    if (this.detectedTransport === 'embedded') {
      try {
        let result: unknown;

        if (this.config.callToolHandler) {
          result = await this.config.callToolHandler(
            toolCall.name,
            toolCall.arguments,
          );
        } else if (this.config.toolCallHandler) {
          // Use provided handler
          result = await this.config.toolCallHandler(
            toolCall.name,
            toolCall.arguments,
          );
        } else {
          throw new Error(
            'No tool call handler available in embedded mode. Provide toolCallHandler in mcpConfig.',
          );
        }

        const normalizedResult =
          typeof result === 'object' && result !== null && 'content' in result
            ? (result as { content: unknown }).content
            : result;
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          result: normalizedResult,
        };
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          result: null,
          error: errorMessage || 'Tool execution failed',
        };
      }
    }

    const performCall = async () => {
      if (!this.client) {
        await this.connect();
      }
      const response = await this.client?.callTool(
        { name: toolCall.name, arguments: toolCall.arguments },
        undefined,
        { timeout: MCP_NO_CLIENT_TIMEOUT_MS, resetTimeoutOnProgress: true },
      );
      if (!response) {
        throw new Error('MCP callTool returned no response');
      }
      return response;
    };

    try {
      const response = await performCall();
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: response.content,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      // Auto-reconnect logic: if it fails, try to connect again and retry once
      try {
        console.warn(`MCP call failed, attempting reconnect: ${errorMessage}`);
        await this.disconnect();
        await this.connect();
        const response = await performCall();
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          result: response.content,
        };
      } catch (retryError: unknown) {
        // Resume-with-session failed — the server may have dropped the session.
        // Clear it and try ONE fresh connect so a truly-gone session does not
        // wedge the client.
        if (this.sessionId) {
          this.sessionId = undefined;
          try {
            await this.disconnect();
            await this.connect();
            const response = await performCall();
            return {
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: response.content,
            };
          } catch {
            /* fall through to throw */
          }
        }
        const retryErrorMessage =
          retryError instanceof Error ? retryError.message : String(retryError);
        // THROW (not return) so McpClientAdapter.callTool's catch maps it to an
        // ok:false availability McpError. Returning { error } would be wrapped
        // ok:true/isError and never escalate to fail-loud / NOT_READY.
        throw toMcpError(
          `${retryErrorMessage || 'Tool execution failed'} (no response after reconnect)`,
        );
      }
    }
  }

  /**
   * Execute multiple tool calls
   */
  async callTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results = await Promise.all(
      toolCalls.map((toolCall) => this.callTool(toolCall)),
    );
    return results;
  }

  /**
   * Lightweight ping — verifies the MCP server is reachable
   * without triggering a full tools/list request.
   */
  async ping(): Promise<void> {
    if (this.detectedTransport === 'embedded') {
      // Embedded mode: server is in-process, always reachable
      return;
    }
    if (!this.client) {
      await this.connect();
    }
    await this.client?.ping();
  }

  /**
   * Disconnect from MCP server
   */
  async disconnect(): Promise<void> {
    // For embedded mode, no need to disconnect
    if (this.detectedTransport === 'embedded') {
      return;
    }

    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
