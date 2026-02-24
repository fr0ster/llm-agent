/**
 * MCP Client Wrapper
 *
 * Wraps the MCP SDK client to provide a simpler interface for the agent
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolCall, ToolResult } from '../types.js';

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
  serverInstance?: any;

  /**
   * For embedded mode: Direct access to tools registry
   * If provided, listTools() will use this instead of calling server
   */
  toolsRegistry?: {
    getAllTools: () => any[];
  };

  /**
   * For embedded mode: Direct tool call handler
   * If provided, callTool() will use this instead of calling server
   */
  toolCallHandler?: (name: string, args: Record<string, any>) => Promise<any>;

  /**
   * Direct tools list provider (DI)
   * Use this to supply tools without relying on MCP transport details.
   */
  listToolsHandler?: () => Promise<any[]>;

  /**
   * Direct tool call provider (DI)
   * Use this to supply tool execution without relying on MCP transport details.
   */
  callToolHandler?: (name: string, args: Record<string, any>) => Promise<any>;

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

  /**
   * Timeout in milliseconds (default: 30000)
   */
  timeout?: number;
}

export class MCPClientWrapper {
  private client: Client | null = null;
  private config: MCPClientConfig;
  private tools: any[] = [];
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
        {
          sessionId: this.config.sessionId,
          requestInit: {
            headers: this.config.headers || {},
            signal: AbortSignal.timeout(this.config.timeout || 30000),
          },
        },
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
   * Get list of available tools
   */
  async listTools(): Promise<any[]> {
    // For embedded mode, tools are already loaded in connect()
    if (this.detectedTransport === 'embedded') {
      return this.tools;
    }

    if (!this.client) {
      await this.connect();
    }

    if (this.tools.length === 0) {
      const response = await this.client!.listTools();
      this.tools = response.tools || [];
    }

    return this.tools;
  }

  /**
   * Execute a tool call
   */
  async callTool(toolCall: ToolCall): Promise<ToolResult> {
    // For embedded mode, use direct handler or server instance
    if (this.detectedTransport === 'embedded') {
      try {
        let result: any;

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
        } else if (this.config.serverInstance?.server) {
          // Use MCP Server instance directly via CallToolRequest
          // The server has request handlers registered, we need to call them
          const { CallToolRequestSchema } = await import(
            '@modelcontextprotocol/sdk/types.js'
          );

          // Create a request object that matches CallToolRequest format
          const request = {
            jsonrpc: '2.0' as const,
            id: 1,
            method: 'tools/call',
            params: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          };

          // Call the handler directly
          // The server.setRequestHandler registers handlers, but we need to access them
          // This is a limitation - provide toolCallHandler for embedded mode
          throw new Error(
            'Direct server.callTool() requires toolCallHandler. Provide toolCallHandler in mcpConfig.',
          );
        } else {
          throw new Error(
            'No tool call handler available in embedded mode. Provide toolCallHandler in mcpConfig.',
          );
        }

        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          result: result.content || result,
        };
      } catch (error: any) {
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          result: null,
          error: error.message || 'Tool execution failed',
        };
      }
    }

    if (!this.client) {
      await this.connect();
    }

    try {
      const response = await this.client!.callTool({
        name: toolCall.name,
        arguments: toolCall.arguments,
      });

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: response.content,
      };
    } catch (error: any) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: error.message || 'Tool execution failed',
      };
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
