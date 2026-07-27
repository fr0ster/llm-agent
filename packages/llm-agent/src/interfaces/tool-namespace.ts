import type { IMcpClient } from './mcp-client.js';

export interface ToolNamespaceContext {
  /** Original tool name the server exposes. */
  toolName: string;
  /** Prefix source resolved by the builder: the server's config `name`, else `s${slotIndex}`. */
  prefix: string;
  /** True when this tool name is exposed by more than one currently-active client. */
  colliding: boolean;
}

export interface IToolNamespace {
  /** Name the LLM sees / RAG stores. Must be non-empty, `^[a-zA-Z0-9_-]+$`, <= 64 chars.
   *  The builder validates this output — an invalid name fails fast. */
  expose(ctx: ToolNamespaceContext): string;
}

/** Bare when unique; `${prefix}__${toolName}` on a collision. */
export const defaultToolNamespace: IToolNamespace = {
  expose: ({ toolName, prefix, colliding }): string =>
    colliding ? `${prefix}__${toolName}` : toolName,
};

/**
 * Wrap an MCP client so `callTool` always targets `originalName`, whatever
 * (exposed) name the caller passes. All other IMcpClient methods proxy straight
 * through. This encapsulates the namespace strip in the tool→client map value,
 * so no executor call site needs to know about namespacing.
 */
export function bindToolCallName(
  client: IMcpClient,
  originalName: string,
): IMcpClient {
  return {
    listTools: (options) => client.listTools(options),
    callTool: (_exposedName, args, options) =>
      client.callTool(originalName, args, options),
    ...(client.healthCheck
      ? { healthCheck: (options) => client.healthCheck?.(options) }
      : {}),
  } as IMcpClient;
}
