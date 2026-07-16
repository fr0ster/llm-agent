import type {
  CallOptions,
  IAuxiliaryMcpTools,
  McpError as McpErrorType,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { McpError } from '@mcp-abap-adt/llm-agent';
import type { AuxToolEntry } from './wait-tool.js';

/**
 * Our example `IAuxiliaryMcpTools`: a fixed list of in-process tool entries.
 * `listTools` returns their defs; `callTool` routes by name to the handler.
 * An unknown name is a tool-level error (NOT thrown — never "unavailable").
 * A handler that REJECTS (e.g. `wait` on abort) propagates unchanged.
 */
export class DefaultAuxiliaryMcpTools implements IAuxiliaryMcpTools {
  private readonly byName: Map<string, AuxToolEntry>;

  constructor(private readonly entries: AuxToolEntry[]) {
    this.byName = new Map(entries.map((e) => [e.def.name, e]));
  }

  async listTools(): Promise<Result<McpTool[], McpErrorType>> {
    return { ok: true, value: this.entries.map((e) => e.def) };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpErrorType>> {
    const entry = this.byName.get(name);
    if (!entry) {
      return {
        ok: false,
        error: new McpError(`unknown auxiliary tool: ${name}`),
      };
    }
    return entry.handler(args, options);
  }
}
