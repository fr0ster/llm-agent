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
The client always sets `resetTimeoutOnProgress` on MCP requests (not a config field): the deadline resets while a tool actively reports progress, so a genuinely-working long-running tool is not cut off.

To convey server-side intent (e.g., "willing to wait longer"), pass a custom `IMcpRequestHeadersStrategy` to `MCPClientWrapper` to inject headers the server recognizes.

## Observability — tool-call durations

Every MCP tool call emits timing through two existing structured channels (no console output, no env flag):

- **`tool_call` structured event** — `ILogger.log({ type: 'tool_call', traceId, toolName, isError, durationMs })`. Consumed by the server's structured logger; verbosity is the logger implementation's concern (run-mode gate applies automatically).
- **`mcp_tool_call` session-debug step** — `sessionLogger.logStep('mcp_tool_call', { toolName, durationMs, isError })`. Lands in per-session artifacts alongside other `coordinator_step_*` entries; visible at debug/verbose run levels.

`isError` is `true` when the client returned `ok: false` or when the tool result carried `isError: true`.

**Tuning hint:** if `durationMs` on a `tool_call` event approaches a tool's resolved timeout (client default or `toolTimeouts` override), the tool is at risk of being cut off — raise the limit for that tool via `MCPClientConfig.toolTimeouts`.

## Dependencies

- `@mcp-abap-adt/llm-agent` — interfaces and DTOs.
- `@modelcontextprotocol/sdk` — official MCP SDK (runtime dependency).

See `docs/ARCHITECTURE.md` for the full SmartAgent package layout.
