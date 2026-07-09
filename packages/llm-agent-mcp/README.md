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

The SmartAgent runtime applies a generous default per-call MCP request timeout of **120000 ms (2 minutes)** as a safety net against stuck or hung tool calls. This is configurable:

- `MCPClientConfig.timeout` (default: 120000 ms) — default per-call timeout for this MCP client.
- `MCPClientConfig.toolTimeouts` — per-tool timeout overrides (ms). Some tools legitimately take 5–15 minutes (e.g., `{ GetWhereUsed: 600000, GetPackageContents: 900000 }`); resolution is per-tool override → client default → 120000 ms.
- `resetTimeoutOnProgress: true` — resets the deadline while a tool actively reports progress, preventing timeout during long-running operations.

To convey server-side intent (e.g., "willing to wait longer"), pass a custom `IMcpRequestHeadersStrategy` to `MCPClientWrapper` to inject headers the server recognizes.

## Dependencies

- `@mcp-abap-adt/llm-agent` — interfaces and DTOs.
- `@modelcontextprotocol/sdk` — official MCP SDK (runtime dependency).

See `docs/ARCHITECTURE.md` for the full SmartAgent package layout.
