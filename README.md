# LLM Proxy

Minimal LLM agent that normalizes provider access and surfaces MCP tools without executing them.

## Overview

This agent acts as a thin orchestration layer between LLM providers and MCP (Model Context Protocol) servers. It provides tool catalogs to the LLM and returns the raw LLM response to the consumer.

**Provider Paths:**
- Direct providers are supported: `OpenAIProvider`, `AnthropicProvider`, `DeepSeekProvider`
- SAP AI Core gateway is also supported via `SapCoreAIProvider`
- In SAP deployments, SAP AI Core is typically the recommended integration path

## Features

- ✅ Multiple LLM provider paths (direct providers and SAP AI Core gateway)
- ✅ MCP client integration with multiple transport protocols
  - ✅ Stdio transport (for local processes)
  - ✅ SSE transport (Server-Sent Events)
  - ✅ Streamable HTTP transport (bidirectional NDJSON)
  - ✅ Auto-detection of transport from URL
- ✅ Tool catalog surfacing (no tool execution at this layer)
- ✅ Conversation history management
- ✅ Raw LLM response passthrough for consumers
- 🔄 Streaming support (planned)

## Installation

```bash
npm install @mcp-abap-adt/llm-agent
```

## Usage

The agent can be used in two ways:

1. **Embedded in application** - Import and use directly in your CAP service or application (same process)
2. **Standalone service** - Run as a separate service/process

Both modes connect to MCP servers via transport protocols (HTTP/SSE/stdio), not directly to MCP server instances.

### Embedded Usage (Same Process)

When using the agent embedded in your application (e.g., in `cloud-llm-hub` CAP service), you import it as a module:

```typescript
// srv/agent-service.ts
import { SapCoreAIAgent, SapCoreAIProvider, MCPClientWrapper } from '@mcp-abap-adt/llm-agent';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';

export default class AgentService extends cds.Service {
  private agent: SapCoreAIAgent;

  async init() {
    // Create SAP AI Core provider (all LLM providers through SAP AI Core)
    const llmProvider = new SapCoreAIProvider({
      destinationName: 'SAP_AI_CORE_DEST', // SAP destination for AI Core
      model: 'gpt-4o-mini', // Model name determines which provider SAP AI Core uses
      httpClient: async (config) => {
        return await executeHttpRequest(
          { destinationName: config.destinationName },
          {
            method: config.method as any,
            url: config.url,
            headers: config.headers,
            data: config.data,
          }
        );
      },
    });

    // Create MCP client
    const mcpClient = new MCPClientWrapper({
      url: 'http://localhost:4004/mcp/stream/http', // MCP proxy endpoint
      headers: {
        'Authorization': 'Basic YWxpY2U6',
        'X-SAP-Destination': 'SAP_DEV_DEST',
      },
    });

    // Create agent
    this.agent = new SapCoreAIAgent({
      llmProvider,
      mcpClient,
    });

    await this.agent.connect();
  }

  async chat(message: string) {
    return await this.agent.process(message);
  }
}
```

**Architecture Note:** 
- The agent is imported as a module (like `@fr0ster/mcp-abap-adt`)
- Even when embedded in the same process, the agent connects to the MCP proxy via HTTP transport
- The MCP proxy embeds the `mcp-abap-adt` server instance
- This keeps the architecture clean: agent → MCP proxy (via HTTP) → embedded MCP server

See [Embedded Usage Guide](../../docs/LLM_AGENT_EMBEDDED_USAGE.md) for complete examples including per-request agent instances and caching strategies.

### Standalone Usage (Separate Process)

### Basic Example (Stdio Transport)

```typescript
import { SapCoreAIAgent, SapCoreAIProvider, MCPClientWrapper } from '@mcp-abap-adt/llm-agent';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';

// Create SAP AI Core provider
const llmProvider = new SapCoreAIProvider({
  destinationName: 'SAP_AI_CORE_DEST',
  model: 'gpt-4o-mini', // Routes to OpenAI through SAP AI Core
  httpClient: async (config) => {
    return await executeHttpRequest(
      { destinationName: config.destinationName },
      {
        method: config.method as any,
        url: config.url,
        headers: config.headers,
        data: config.data,
      }
    );
  },
});

const mcpClient = new MCPClientWrapper({
  transport: 'stdio',
  command: 'node',
  args: ['path/to/mcp-server.js'],
});

const agent = new SapCoreAIAgent({
  llmProvider,
  mcpClient,
});

await agent.connect();
const response = await agent.process('What tools are available?');
console.log(response.message);
```

### HTTP Transport (Auto-Detection)

```typescript
import { Agent, OpenAIProvider, MCPClientWrapper } from '@mcp-abap-adt/llm-agent';

const llmProvider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
});

// Auto-detects 'stream-http' from URL
const mcpClient = new MCPClientWrapper({
  url: 'http://localhost:4004/mcp/stream/http',
  headers: {
    'Authorization': 'Basic YWxpY2U6',
    'Content-Type': 'application/x-ndjson',
  },
});

const agent = new Agent({
  llmProvider,
  mcpClient,
});

await mcpClient.connect();
const sessionId = mcpClient.getSessionId(); // Get session ID for subsequent requests

const response = await agent.process('What tools are available?');
// The response is returned as-is; tool execution is handled by the consumer.
console.log(response.message);
```

### Explicit Transport Selection

```typescript
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
  },
});
```

See [src/mcp/README.md](src/mcp/README.md) for detailed transport configuration options.

### Embedded Usage in CAP Service

The agent can be imported and used directly in CAP services, similar to how `mcp-abap-adt` is used:

```typescript
// srv/agent-service.ts
import { Agent, OpenAIProvider } from '@mcp-abap-adt/llm-agent';

export default class AgentService extends cds.Service {
  private agent: Agent;

  async init() {
    this.agent = new Agent({
      llmProvider: new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY!,
      }),
      mcpConfig: {
        url: 'http://localhost:4004/mcp/stream/http',
        headers: {
          'Authorization': 'Basic YWxpY2U6',
          'X-SAP-Destination': 'SAP_DEV_DEST',
        },
      },
    });

    await this.agent.connect();
  }

  async chat(message: string) {
    return await this.agent.process(message);
  }
}
```

See [docs/LLM_AGENT_EMBEDDED_USAGE.md](../../docs/LLM_AGENT_EMBEDDED_USAGE.md) for complete embedded usage guide.

## Development

**Cross-Platform Development:** This project is configured for consistent behavior across Windows, Linux, and macOS. See the parent project's [Cross-Platform Development Guide](../../docs/CROSS_PLATFORM_GUIDE.md) for setup instructions and troubleshooting.

**Verify your setup:** Run `npm run verify:setup` from the root project to check cross-platform configuration.

```bash
# Install dependencies
npm install

# Setup environment (copy template and fill in your values)
cp .env.template .env
# Edit .env with your API keys and settings

# Build
npm run build

# Development mode (with tsx for hot reload)
# Will automatically load .env file if it exists
npm run dev

# Run test launcher (after build)
npm start

# Or with custom message
npm start "List all available ABAP programs"
```

### Environment Configuration

The agent supports configuration via `.env` file for easier setup:

1. Copy the template:
   ```bash
   cp .env.template .env
   ```

2. Edit `.env` with your settings:
   ```bash
   # Direct provider configuration (used by current CLI launcher)
   LLM_PROVIDER=openai  # openai | anthropic | deepseek
   OPENAI_API_KEY=sk-proj-your-key
   OPENAI_MODEL=gpt-4o-mini
   
   # MCP Configuration (optional, for MCP integration)
   MCP_ENDPOINT=http://localhost:4004/mcp/stream/http
   MCP_DISABLED=false
   ```
   
   **Optional (library-level SAP AI Core provider):**
   SAP_CORE_AI_URL=https://api.ai.core.sap
   SAP_CORE_AI_DESTINATION=SAP_AI_CORE_DEST

3. Run the agent - it will automatically load `.env`:
   ```bash
   npm run dev:llm
   ```

Environment variables from `.env` can be overridden by actual environment variables.

### Test Launcher

The agent includes a simple CLI test launcher for quick testing.

**Note:** The current CLI launcher uses direct providers (`openai`, `anthropic`, `deepseek`). `ollama` is listed in comments but not implemented.

#### Test LLM Only (Without MCP)

Test just the LLM provider without MCP integration:

**OpenAI:**
```bash
# Basic usage - set API key and run
export OPENAI_API_KEY="sk-proj-your-actual-key-here"
npm run dev:llm

# Or inline
OPENAI_API_KEY="sk-proj-your-key" npm run dev:llm

# With custom message
export OPENAI_API_KEY="sk-proj-your-key"
npm run dev:llm "Hello! Can you introduce yourself?"

# With specific model
export OPENAI_API_KEY="sk-proj-your-key"
export OPENAI_MODEL="gpt-4o"  # or gpt-4-turbo, gpt-4o-mini, etc.
npm run dev:llm

# With organization ID (for team accounts)
export OPENAI_API_KEY="sk-proj-your-key"
export OPENAI_ORG="org-your-org-id"
npm run dev:llm

# With project ID (for project-specific billing)
export OPENAI_API_KEY="sk-proj-your-key"
export OPENAI_PROJECT="proj-your-project-id"  # or OPENAI_PRJ
npm run dev:llm

# Full configuration
export OPENAI_API_KEY="sk-proj-your-key"
export OPENAI_MODEL="gpt-4o"
export OPENAI_ORG="org-your-org-id"
export OPENAI_PROJECT="proj-your-project-id"
npm run dev:llm
```

**Anthropic (Claude):**
```bash
# Set provider and API key
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY="sk-ant-your-actual-key-here"
npm run dev:llm

# With custom message
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY="sk-ant-your-key"
npm run dev:llm "What can you do?"

# With specific model
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY="sk-ant-your-key"
export ANTHROPIC_MODEL="claude-3-5-sonnet-20241022"  # or claude-3-opus, etc.
npm run dev:llm
```

**DeepSeek:**
```bash
# Set provider and API key
export LLM_PROVIDER=deepseek
export DEEPSEEK_API_KEY="sk-your-actual-key-here"
npm run dev:llm

# With custom message
export LLM_PROVIDER=deepseek
export DEEPSEEK_API_KEY="sk-your-key"
npm run dev:llm "Explain what you can do"
```

**Alternative methods:**
```bash
# Method 1: Using dedicated script (recommended)
export OPENAI_API_KEY="sk-proj-..."
npm run dev:llm

# Method 2: Using flag
export OPENAI_API_KEY="sk-proj-..."
npm run dev -- --llm-only

# Method 3: Using environment variable
export OPENAI_API_KEY="sk-proj-..."
export MCP_DISABLED=true
npm run dev
```

#### Basic Usage with OpenAI (With MCP)

```bash
# Method 1: Export environment variable
export OPENAI_API_KEY="sk-proj-..."
export MCP_ENDPOINT="http://localhost:4004/mcp/stream/http"
npm run dev

# Method 2: Inline (one-time use)
OPENAI_API_KEY="sk-proj-..." npm run dev

# Method 3: With custom message
export OPENAI_API_KEY="sk-proj-..."
npm run dev "What ABAP programs are available?"

# Method 4: Using .env file (if you have dotenv setup)
# Create .env file:
# OPENAI_API_KEY=sk-proj-...
# MCP_ENDPOINT=http://localhost:4004/mcp/stream/http
npm run dev
```

#### Complete Example

```bash
# From project root
cd submodules/llm-agent

# Set required environment variables
export OPENAI_API_KEY="sk-proj-your-actual-key-here"
export MCP_ENDPOINT="http://localhost:4004/mcp/stream/http"
export SAP_DESTINATION="SAP_DEV_DEST"  # Optional, for SAP integration

# Optional: Set model
export OPENAI_MODEL="gpt-4o-mini"  # or gpt-4o, gpt-4-turbo, etc.

# Run test launcher
npm run dev

# Or with custom message
npm run dev "List all available tools and describe what they do"
```

#### Testing with Different LLM Providers

**Anthropic (Claude):**
```bash
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY="sk-ant-your-key-here"
export ANTHROPIC_MODEL="claude-3-5-sonnet-20241022"  # Optional
npm run dev
```

**DeepSeek:**
```bash
export LLM_PROVIDER=deepseek
export DEEPSEEK_API_KEY="sk-your-key-here"
export DEEPSEEK_MODEL="deepseek-chat"  # Optional
npm run dev
```

#### Example Output

```
🤖 LLM Proxy Test Launcher v0.0.1

📋 Configuration:
   LLM Provider: openai
   MCP Endpoint: http://localhost:4004/mcp/stream/http
   Test Message: What tools are available?

✅ Created OpenAI provider
✅ Created MCP client

✅ Created agent instance
   Agent type: OpenAIAgent

🔌 Connecting to MCP server...
✅ Connected to MCP server

📦 Available tools: 31
   - GetProgram: Retrieve ABAP program source code...
   - GetClass: Retrieve ABAP class source code...
   - GetFunction: Retrieve ABAP function module...
   ... and 28 more

💬 Processing message: "What tools are available?"

📤 Response:
────────────────────────────────────────────────────────────
I can see you have 31 tools available for working with ABAP systems...

⏱️  Duration: 2341ms

📜 Conversation history: 4 messages

✅ Test completed successfully!
```

The test launcher will:
- Connect to MCP server
- List available tools
- Process a test message
- Show response
- Display conversation history

## Tool Execution Responsibility

The agent does not execute tools. It only:
- Fetches MCP tool catalogs
- Passes tool definitions to the LLM
- Returns the raw LLM response to the consumer

If your application needs tool execution, parse the model output in the consumer layer and call MCP tools there.

## Architecture

- `src/agents/` - Agent implementations (BaseAgent, SapCoreAIAgent, etc.)
- `src/llm-providers/` - LLM provider implementations (OpenAI, Anthropic, DeepSeek, SapCoreAI)
- `src/mcp/` - MCP client wrapper
- `src/types.ts` - TypeScript type definitions

## License

MIT
