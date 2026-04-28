/**
 * MCP Client Wrapper
 *
 * Wraps the MCP SDK client to provide a simpler interface for the agent
 */
import type { ToolCall, ToolResult } from '@mcp-abap-adt/llm-agent';
type McpToolDef = {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
};
type EmbeddedServerInstance = {
    server?: unknown;
};
export type TransportType = 'stdio' | 'sse' | 'stream-http' | 'auto' | 'embedded';
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
    toolCallHandler?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    /**
     * Direct tools list provider (DI)
     * Use this to supply tools without relying on MCP transport details.
     */
    listToolsHandler?: () => Promise<McpToolDef[]>;
    /**
     * Direct tool call provider (DI)
     * Use this to supply tool execution without relying on MCP transport details.
     */
    callToolHandler?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
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
export declare class MCPClientWrapper {
    private client;
    private config;
    private tools;
    private detectedTransport;
    private sessionId?;
    constructor(config: MCPClientConfig);
    /**
     * Detect transport type from config
     */
    private detectTransport;
    /**
     * Initialize MCP client connection
     */
    connect(): Promise<void>;
    /**
     * Get detected transport type
     */
    getTransport(): TransportType;
    /**
     * Get current session ID (for HTTP transports)
     */
    getSessionId(): string | undefined;
    /**
     * Get list of available tools
     */
    listTools(): Promise<McpToolDef[]>;
    /**
     * Execute a tool call
     */
    callTool(toolCall: ToolCall): Promise<ToolResult>;
    /**
     * Execute multiple tool calls
     */
    callTools(toolCalls: ToolCall[]): Promise<ToolResult[]>;
    /**
     * Lightweight ping — verifies the MCP server is reachable
     * without triggering a full tools/list request.
     */
    ping(): Promise<void>;
    /**
     * Disconnect from MCP server
     */
    disconnect(): Promise<void>;
}
export {};
//# sourceMappingURL=client.d.ts.map