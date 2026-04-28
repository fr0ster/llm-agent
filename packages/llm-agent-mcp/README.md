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

## Dependencies

- `@mcp-abap-adt/llm-agent` — interfaces and DTOs.
- `@modelcontextprotocol/sdk` — official MCP SDK (runtime dependency).

See `docs/ARCHITECTURE.md` for the full SmartAgent package layout.
