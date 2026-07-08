# @mcp-abap-adt/llm-agent-mcp

MCP client wrapper, adapter, factory, and connection strategies for the SmartAgent runtime.

## Exports

- `MCPClientWrapper`, `MCPClientConfig`, `TransportType`
- `McpClientAdapter`
- `createDefaultMcpClient(...)`
- Connection strategies: `LazyConnectionStrategy`, `PeriodicConnectionStrategy`, `NoopConnectionStrategy`

## Usage

```ts
import {
  MCPClientWrapper,
  McpClientAdapter,
} from '@mcp-abap-adt/llm-agent-mcp';

const client = new MCPClientWrapper({
  transport: 'stream-http',
  url: process.env.MCP_ENDPOINT,
});
await client.connect();

const adapter = new McpClientAdapter(client);
```

## Request Timeouts

The SmartAgent runtime imposes no client-side timeout on MCP tool calls — the MCP server governs its own. The `MCPClientConfig.timeout` field is deprecated and has no effect (retained for backward compatibility). To convey a "willing to wait" hint, pass a custom `IMcpRequestHeadersStrategy` to `MCPClientWrapper` to inject headers the server recognizes.

## Dependencies

- `@mcp-abap-adt/llm-agent` — interfaces and DTOs.
- `@modelcontextprotocol/sdk` — official MCP SDK (runtime dependency).

See `docs/ARCHITECTURE.md` for the full SmartAgent package layout.
