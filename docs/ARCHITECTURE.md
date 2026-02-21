# Architecture

## Overview

**LLM Proxy** (`@mcp-abap-adt/llm-proxy`) is a minimal orchestration layer between LLM providers and MCP (Model Context Protocol) servers. It surfaces MCP tool catalogs to the LLM and returns the raw LLM response to the consumer — without executing tools itself.

```
┌──────────────────────────────────────────────────────────────┐
│                     Consumer / CLI                            │
│              (CAP service, application, cli.ts)               │
└───────────┬──────────────────────────────┬───────────────────┘
            │  process(message)            │  callTool(toolCall)
            ▼                              ▼
┌───────────────────────┐      ┌───────────────────────────────┐
│     Agent Layer        │      │      MCPClientWrapper          │
│  (BaseAgent subclass)  │◄────►│  (src/mcp/client.ts)          │
│                        │      │                               │
│  • Conversation history│      │  ┌─────────────────────────┐  │
│  • Tool formatting     │      │  │  Transport Layer         │  │
│  • LLM communication   │      │  │                         │  │
└───────────┬────────────┘      │  │  stdio | sse | stream-  │  │
            │                   │  │          http | embedded │  │
            ▼                   │  └────────────┬────────────┘  │
┌───────────────────────┐      │               │               │
│   LLM Provider         │      │               ▼               │
│  (SapCoreAIProvider    │      │  ┌─────────────────────────┐  │
│   or direct providers) │      │  │  @modelcontextprotocol/ │  │
│                        │      │  │  sdk                    │  │
└───────────┬────────────┘      │  └─────────────────────────┘  │
            │                   └───────────────────────────────┘
            ▼
┌───────────────────────┐
│    SAP AI Core         │
│  (proxy / gateway)     │
│                        │
│  Routes to:            │
│  • OpenAI              │
│  • Anthropic           │
│  • DeepSeek            │
└────────────────────────┘
```

### Key Design Decisions

1. **No automatic tool execution.** The agent surfaces tool calls from the LLM but never executes them. The consumer decides what to do with `AgentResponse.raw`.
2. **SAP AI Core as primary gateway.** All LLM providers are accessed through SAP AI Core. Direct provider classes exist for backward compatibility and testing.
3. **Multi-transport MCP.** A single `MCPClientWrapper` handles Stdio, SSE, Streamable HTTP, and embedded (in-process) transports with automatic detection.
4. **Minimal dependencies.** Only three runtime dependencies: `@modelcontextprotocol/sdk`, `axios`, `dotenv`.

---

## Project Structure

```
src/
├── index.ts                    # Public API — re-exports everything
├── cli.ts                      # CLI test launcher (dev tool, not part of library API)
├── agent.ts                    # Legacy Agent class (deprecated)
├── types.ts                    # Core type definitions
├── agents/
│   ├── index.ts                # Barrel exports
│   ├── base.ts                 # BaseAgent — abstract class with shared logic
│   ├── openai-agent.ts         # Native function calling (OpenAI tools API)
│   ├── anthropic-agent.ts      # Native tools API (Anthropic content blocks)
│   ├── deepseek-agent.ts       # Native function calling (OpenAI-compatible)
│   ├── prompt-based-agent.ts   # Fallback — tools described in system prompt
│   └── sap-core-ai-agent.ts    # Thin wrapper over PromptBasedAgent for SAP AI Core
├── llm-providers/
│   ├── index.ts                # Barrel exports
│   ├── base.ts                 # LLMProvider interface + BaseLLMProvider abstract class
│   ├── openai.ts               # Direct OpenAI API (legacy)
│   ├── anthropic.ts            # Direct Anthropic API (legacy)
│   ├── deepseek.ts             # Direct DeepSeek API (legacy)
│   └── sap-core-ai.ts          # Primary provider — routes through SAP AI Core
└── mcp/
    ├── client.ts               # MCPClientWrapper — multi-transport MCP client
    └── README.md               # Transport configuration documentation
```

---

## Core Types

All shared contracts are defined in `src/types.ts`:

| Type | Purpose |
|---|---|
| `Message` | Chat message with `role` (user / assistant / system / tool) and `content` |
| `ToolCall` | LLM-requested tool invocation: `id`, `name`, `arguments` |
| `ToolResult` | Result of a tool execution: `toolCallId`, `name`, `result`, `error?` |
| `AgentResponse` | What `agent.process()` returns: `message`, `raw?`, `error?` |
| `LLMResponse` | What a provider's `chat()` returns: `content`, `raw?`, `finishReason?` |
| `LLMProviderConfig` | Base provider config: `apiKey`, `baseURL?`, `model?`, `temperature?`, `maxTokens?` |

---

## Agent Layer

### Class Hierarchy

The agent layer uses the **Template Method** pattern. `BaseAgent` defines the processing loop; subclasses plug in provider-specific tool formatting.

```
BaseAgent (abstract)
├── OpenAIAgent              — native function calling via `tools` param
├── AnthropicAgent           — native tools API with content blocks
├── DeepSeekAgent            — OpenAI-compatible function calling
└── PromptBasedAgent         — tools described in system prompt text
    └── SapCoreAIAgent       — recommended agent, extends PromptBasedAgent
```

### BaseAgent Lifecycle

```
  constructor(config)
       │
       ▼
  connect()  ─────► mcpClient.connect()
       │                    │
       │             mcpClient.listTools()
       │                    │
       │              this.tools = [...]
       ▼
  process(userMessage)
       │
       ├── 1. Push { role: 'user', content } to conversationHistory
       │
       ├── 2. callLLMWithTools(conversationHistory, tools)
       │       │
       │       └── [abstract — implemented by subclass]
       │
       ├── 3. Push { role: 'assistant', content } to conversationHistory
       │
       └── 4. Return AgentResponse { message, raw? }
```

The `process()` method performs a **single-turn request-response**. There is no automatic tool execution loop — `maxIterations` exists in the config but is reserved for future use.

### How Each Agent Handles Tools

| Agent | Strategy | API Format |
|---|---|---|
| `OpenAIAgent` | Converts MCP tools to OpenAI function calling schema. Passes `tools` and `tool_choice: 'auto'` in the request body. | `POST /chat/completions` with `tools: [{ type: 'function', function: { name, description, parameters } }]` |
| `AnthropicAgent` | Converts MCP tools to Anthropic tool format. Extracts system message into a separate field. Iterates response content blocks. | `POST /messages` with `tools: [{ name, description, input_schema }]` |
| `DeepSeekAgent` | Identical to OpenAI (DeepSeek uses OpenAI-compatible API). | Same as OpenAI |
| `PromptBasedAgent` | Injects tool descriptions directly into the system prompt. Asks the LLM to respond with JSON or `TOOL_CALL:` format. | Standard `chat(messages)` — no native tool API |
| `SapCoreAIAgent` | Inherits PromptBasedAgent. Placeholder for future SAP AI Core-specific tool handling. | Same as PromptBasedAgent |

> **Note:** `OpenAIAgent`, `AnthropicAgent`, and `DeepSeekAgent` bypass the `LLMProvider.chat()` interface and access provider internals (`client`, `model`, `config`) via `as any` cast, because `chat()` does not accept tool definitions. Only `PromptBasedAgent` uses the high-level `LLMProvider.chat()` method.

### Legacy Agent (src/agent.ts)

The original `Agent` class follows a simpler prompt-based approach: it injects tool names into the system prompt on every `process()` call. It is deprecated in favor of the `BaseAgent` hierarchy but remains exported for backward compatibility.

---

## LLM Provider Layer

### Interface

```typescript
interface LLMProvider {
  chat(messages: Message[]): Promise<LLMResponse>;
  streamChat?(messages: Message[]): AsyncGenerator<LLMResponse>;  // planned
  getModels?(): Promise<string[]>;                                 // optional
}
```

All providers return the same `LLMResponse` shape, making them interchangeable at the `chat()` level.

### Providers

| Provider | Auth | API | Status |
|---|---|---|---|
| `SapCoreAIProvider` | SAP Destination (via Cloud SDK `httpClient` injection) | `POST /v1/chat/completions` (OpenAI-compatible) | **Primary / Recommended** |
| `OpenAIProvider` | Bearer token | `POST /chat/completions` | Legacy (for testing) |
| `AnthropicProvider` | `x-api-key` + `anthropic-version` header | `POST /messages` | Legacy (for testing) |
| `DeepSeekProvider` | Bearer token | `POST /chat/completions` | Legacy (for testing) |

### SapCoreAIProvider — Primary Provider

SAP AI Core acts as a unified gateway. The `model` field determines which backend LLM the request is routed to:

```
model: 'gpt-4o-mini'        → SAP AI Core → OpenAI
model: 'claude-3-5-sonnet'  → SAP AI Core → Anthropic
model: 'deepseek-chat'      → SAP AI Core → DeepSeek
```

Two modes of HTTP communication:

1. **Production** — an injected `httpClient` function (typically `executeHttpRequest` from SAP Cloud SDK) handles authentication and destination routing.
2. **Standalone fallback** — raw `axios` calls to `SAP_CORE_AI_URL` env var (for testing without SAP SDK).

---

## MCP Layer

### MCPClientWrapper

`MCPClientWrapper` (`src/mcp/client.ts`) is the single abstraction for all MCP communication. Agents and consumers never use the `@modelcontextprotocol/sdk` directly.

### Transport Types

| Transport | SDK Class | Protocol | Use Case |
|---|---|---|---|
| `stdio` | `StdioClientTransport` | JSON-RPC over stdin/stdout | Local MCP server processes |
| `sse` | `StreamableHTTPClientTransport` | Server-Sent Events | Web apps, simple streaming |
| `stream-http` | `StreamableHTTPClientTransport` | Streamable HTTP (bidirectional NDJSON) | Production, complex workflows |
| `auto` | (resolved at runtime) | Detected from URL patterns | Default / convenience |
| `embedded` | (none) | Direct function calls in-process | Testing, same-process MCP server |

> Both `sse` and `stream-http` use the same SDK class (`StreamableHTTPClientTransport`). The SDK handles protocol differences internally.

### Transport Auto-Detection

When `transport` is `auto` (default) or omitted:

1. If `listToolsHandler`, `callToolHandler`, or `serverInstance` is provided → `embedded`
2. If URL contains `/sse` → `sse`
3. If URL contains `/stream/http` or `/http` → `stream-http`
4. Any other HTTP/HTTPS URL → `stream-http`
5. If `command` is provided → `stdio`
6. Otherwise → error with helpful message

### API

| Method | Description |
|---|---|
| `connect()` | Establish connection and load tool catalog |
| `listTools()` | Return cached tool descriptors |
| `callTool(toolCall)` | Execute a single tool (returns `ToolResult`) |
| `callTools(toolCalls)` | Execute multiple tools in parallel |
| `disconnect()` | Close connection |
| `getTransport()` | Return detected transport type |
| `getSessionId()` | Return HTTP session ID (stream-http / sse) |

### Embedded Mode

Embedded mode enables dependency injection for testing and same-process MCP servers:

```typescript
const mcpClient = new MCPClientWrapper({
  listToolsHandler: async () => [...tools],
  callToolHandler: async (name, args) => { /* execute */ },
});
```

No network I/O occurs — tools are resolved via provided handler functions.

---

## Data Flow

### Single-Turn Agent Flow (normal usage)

```
Consumer                  Agent                  LLM Provider           MCP
   │                        │                        │                   │
   │  process("message")    │                        │                   │
   │───────────────────────►│                        │                   │
   │                        │  callLLMWithTools()    │                   │
   │                        │  (format tools for     │                   │
   │                        │   specific provider)   │                   │
   │                        │───────────────────────►│                   │
   │                        │                        │  HTTP request     │
   │                        │                        │  (chat/completions│
   │                        │                        │   or /messages)   │
   │                        │                        │──────────────────►│
   │                        │                        │                   │
   │                        │                        │◄──────────────────│
   │                        │◄───────────────────────│                   │
   │                        │                        │                   │
   │  AgentResponse         │                        │                   │
   │  { message, raw }      │                        │                   │
   │◄───────────────────────│                        │                   │
   │                        │                        │                   │
   │  (consumer parses raw  │                        │                   │
   │   for tool_calls and   │                        │                   │
   │   executes them via    │                        │                   │
   │   mcpClient.callTool)  │                        │                   │
```

### MCP Connection Flow

```
MCPClientWrapper
       │
       ├── detectTransport() ── resolves transport type from config
       │
       ├── connect()
       │     │
       │     ├── [embedded] load tools from handler/registry
       │     │
       │     ├── [stdio] spawn process → StdioClientTransport → Client.connect()
       │     │
       │     └── [sse/stream-http] StreamableHTTPClientTransport → Client.connect()
       │           │
       │           └── capture sessionId
       │
       ├── listTools() → return cached tools[]
       │
       ├── callTool(toolCall) → delegate to client or handler
       │
       └── disconnect() → Client.close()
```

---

## Configuration

There is no dedicated configuration module. Configuration flows through typed constructor parameters at every layer:

| Layer | Config Type | Key Fields |
|---|---|---|
| Agent | `BaseAgentConfig` (+ subclass-specific) | `mcpClient` or `mcpConfig`, `llmProvider`, `maxIterations` |
| LLM Provider | `LLMProviderConfig` / `SapCoreAIConfig` | `apiKey`, `baseURL`, `model`, `destinationName`, `httpClient` |
| MCP Client | `MCPClientConfig` | `transport`, `url`, `command`, `args`, `headers`, `timeout`, `sessionId` |

For the CLI test launcher (`src/cli.ts`), configuration comes from environment variables loaded via `dotenv`:

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | Provider selection (openai / anthropic / deepseek / ollama) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY` | Provider API keys |
| `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `DEEPSEEK_MODEL` | Model override |
| `MCP_ENDPOINT` | MCP server URL |
| `MCP_DISABLED` | Skip MCP connection |
| `MCP_AUTH_HEADER` | Authorization header for MCP |
| `SAP_CORE_AI_DESTINATION` | SAP destination name |
| `SAP_CORE_AI_URL` | Direct SAP AI Core URL (standalone fallback) |

---

## Dependencies

### Runtime (3)

| Package | Version | Purpose |
|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.27.0 | MCP protocol: Client, transports, schemas |
| `axios` | ^1.13.5 | HTTP client for LLM provider APIs |
| `dotenv` | ^17.3.1 | Environment variable loading from `.env` |

### Development (4)

| Package | Version | Purpose |
|---|---|---|
| `@biomejs/biome` | ^2.4.4 | Linter and formatter |
| `@types/node` | ^25.3.0 | Node.js type definitions |
| `tsx` | ^4 | TypeScript execution for development |
| `typescript` | ^5 | TypeScript compiler |

---

## Build & Tooling

- **TypeScript**: ES2022 target, ES module output, strict mode, declarations + source maps
- **Linting/Formatting**: Biome (2-space indent, single quotes, semicolons, organized imports)
- **Package type**: ESM (`"type": "module"`)
- **Node requirement**: >= 18

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Run CLI launcher with tsx (hot reload) |
| `npm run dev:llm` | Run CLI in LLM-only mode (no MCP) |
| `npm run lint` | Lint and auto-fix with Biome |
| `npm run format` | Format with Biome |
| `npm run clean` | Remove `dist/` |
