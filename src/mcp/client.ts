/**
 * MCP Client Wrapper
 * 
 * Wraps the MCP SDK client to provide a simpler interface for the agent
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolCall, ToolResult } from '../types.js';

export interface MCPClientConfig {
  /**
   * Transport type: 'stdio' or 'http'
   */
  transport: 'stdio' | 'http';
  
  /**
   * For stdio: command and args
   */
  command?: string;
  args?: string[];
  
  /**
   * For HTTP: URL endpoint
   */
  url?: string;
  
  /**
   * Session ID for HTTP transport
   */
  sessionId?: string;
}

export class MCPClientWrapper {
  private client: Client | null = null;
  private config: MCPClientConfig;
  private tools: any[] = [];

  constructor(config: MCPClientConfig) {
    this.config = config;
  }

  /**
   * Initialize MCP client connection
   */
  async connect(): Promise<void> {
    if (this.config.transport === 'stdio') {
      if (!this.config.command) {
        throw new Error('Command is required for stdio transport');
      }
      
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args || [],
      });
      
      this.client = new Client({
        name: 'llm-agent',
        version: '0.1.0',
      }, {
        capabilities: {},
      });

      await this.client.connect(transport);
      
      // List available tools
      const toolsResponse = await this.client.listTools();
      this.tools = toolsResponse.tools || [];
    } else {
      // HTTP transport - will be implemented later
      throw new Error('HTTP transport not yet implemented');
    }
  }

  /**
   * Get list of available tools
   */
  async listTools(): Promise<any[]> {
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
      toolCalls.map(toolCall => this.callTool(toolCall))
    );
    return results;
  }

  /**
   * Disconnect from MCP server
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}

