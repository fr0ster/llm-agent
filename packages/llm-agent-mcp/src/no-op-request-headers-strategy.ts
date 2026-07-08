import type { IMcpRequestHeadersStrategy } from '@mcp-abap-adt/llm-agent';

/** Default: contribute nothing — MCP self-governs its timeout. */
export class NoopMcpRequestHeadersStrategy
  implements IMcpRequestHeadersStrategy
{
  headers(): Record<string, string> {
    return {};
  }
}
