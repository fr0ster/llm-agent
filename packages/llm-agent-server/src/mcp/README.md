# MCP Client Configuration

## Transport Protocol Selection

The MCP Client supports multiple transport protocols. You can specify the transport explicitly or let it be auto-detected.

### Transport Types

1. **`stdio`** - Standard input/output (for local processes)
2. **`sse`** - Server-Sent Events (GET endpoint)
3. **`stream-http`** - Streamable HTTP (POST endpoint, bidirectional NDJSON)
4. **`auto`** - Automatically detect from URL (default)
5. **`embedded`** - Direct in-process MCP server instance (same process, no transport; used for testing)

### Configuration Examples

#### 1. Explicit Transport Selection

```typescript
import { MCPClientWrapper } from '@mcp-abap-adt/llm-agent-mcp';

// Stdio transport
const stdioClient = new MCPClientWrapper({
  transport: 'stdio',
  command: 'node',
  args: ['path/to/mcp-server.js'],
});

// SSE transport
const sseClient = new MCPClientWrapper({
  transport: 'sse',
  url: 'http://localhost:4004/mcp/stream/sse',
  headers: {
    'Authorization': 'Basic YWxpY2U6',
  },
});

// Streamable HTTP transport
const httpClient = new MCPClientWrapper({
  transport: 'stream-http',
  url: 'http://localhost:4004/mcp/stream/http',
  headers: {
    'Authorization': 'Basic YWxpY2U6',
    'Content-Type': 'application/x-ndjson',
  },
});
```

#### 2. Auto-Detection from URL

```typescript
// Auto-detects 'sse' from URL containing '/sse'
const sseClient = new MCPClientWrapper({
  url: 'http://localhost:4004/mcp/stream/sse',
  headers: {
    'Authorization': 'Basic YWxpY2U6',
  },
});

// Auto-detects 'stream-http' from URL containing '/http'
const httpClient = new MCPClientWrapper({
  url: 'http://localhost:4004/mcp/stream/http',
  headers: {
    'Authorization': 'Basic YWxpY2U6',
  },
});

// Defaults to 'stream-http' for HTTP URLs
const defaultClient = new MCPClientWrapper({
  url: 'http://localhost:4004/mcp',
  headers: {
    'Authorization': 'Basic YWxpY2U6',
  },
});
```

#### 3. Session Management (Streamable HTTP)

```typescript
// First request - omit sessionId
const client = new MCPClientWrapper({
  transport: 'stream-http',
  url: 'http://localhost:4004/mcp/stream/http',
  headers: {
    'Authorization': 'Basic YWxpY2U6',
  },
});

await client.connect();
const sessionId = client.getSessionId(); // Get session ID from response

// Subsequent requests - include sessionId
const client2 = new MCPClientWrapper({
  transport: 'stream-http',
  url: 'http://localhost:4004/mcp/stream/http',
  sessionId: sessionId, // Reuse session
  headers: {
    'Authorization': 'Basic YWxpY2U6',
    'Mcp-Session-Id': sessionId,
  },
});
```

### Auto-Detection Rules

When `transport: 'auto'` (or not specified), the client detects transport from:

1. **URL patterns:**
   - URLs containing `/sse` or ending with `/sse` → `sse`
   - URLs containing `/stream/http` or `/http` → `stream-http`
   - Other HTTP/HTTPS URLs → `stream-http` (default)

2. **Command presence:**
   - If `command` is provided → `stdio`

3. **Explicit transport:**
   - If `transport` is explicitly set → use that value

### When to Use Each Transport

- **`stdio`**: Local development, CLI tools, direct process communication
- **`sse`**: Web applications, simple one-way streaming, easier to implement
- **`stream-http`**: Production deployments, bidirectional communication, better for complex workflows

### Error Handling

If transport cannot be determined, an error is thrown with helpful suggestions:

```typescript
try {
  const client = new MCPClientWrapper({});
} catch (error) {
  // Error: Cannot determine transport type. Please provide either:
  //   - transport: "stdio" with command
  //   - transport: "sse" or "stream-http" with url
  //   - url (will auto-detect transport)
}
```

## Multiple MCP Servers & Tool Namespacing

The server-level `mcp:` config accepts either a single server or a **list**. Each
entry may carry an optional `name`:

```yaml
mcp:
  - name: erp                                   # optional label
    type: http
    url: http://localhost:3001/mcp/stream/http
  - name: crm
    type: stream-http
    url: http://localhost:3002/mcp/stream/http
```

- **`name`** — optional per-server label. Validated at startup: `^[a-zA-Z0-9_-]+$`,
  non-empty, and **unique** across servers. Used as the tool-name prefix on a
  collision (see below); has no effect on transport/routing otherwise.

When more than one connected server exposes a tool with the **same name**, the
runtime exposes **namespaced** names to the model so every colliding tool stays
individually callable (before, only the first server's copy was reachable):

- Colliding name → `${name}__${tool}` (e.g. `erp__Search` / `crm__Search`). With
  no `name`, the fallback prefix is the server's slot index: `s0__Search`,
  `s1__Search`.
- A **unique** tool name stays **bare** — single-server deployments are byte-for-byte
  unchanged.
- The exposed (namespaced) name is what the model selects; the call is dispatched to
  the owning server with the **original** tool name on the wire.

The naming rule is a swappable strategy (`IToolNamespace`) — inject a custom one via
`SmartAgentBuilder.withToolNamespace(...)` or `BuildAgentDeps.toolNamespace`. Custom
connectors that need to carry per-server labels/descriptors implement the additive
`BuildAgentDeps.connectMcpWithDescriptors` seam (the bare `connectMcp` seam still
works, with slot-index prefixes).
