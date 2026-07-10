import type { IMcpRequestHeadersStrategy } from '@mcp-abap-adt/llm-agent';

/** Default: contribute no extra headers. The request timeout is governed by
 *  `MCPClientConfig.timeout`/`toolTimeouts` (client-side), independent of this. */
export class NoopMcpRequestHeadersStrategy
  implements IMcpRequestHeadersStrategy
{
  headers(): Record<string, string> {
    return {};
  }
}
