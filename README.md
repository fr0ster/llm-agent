# LLM Agent

Minimal LLM agent orchestrating MCP tools across multiple LLM providers.

## Overview

This agent acts as an orchestrator between LLM providers (OpenAI, Anthropic, etc.) and MCP (Model Context Protocol) servers, allowing LLMs to interact with external tools and services.

## Features

- ✅ Multiple LLM provider support (OpenAI implemented)
- ✅ MCP client integration
- ✅ Tool orchestration
- ✅ Conversation history management
- 🔄 Streaming support (planned)
- 🔄 HTTP transport for MCP (planned)

## Installation

```bash
npm install
npm run build
```

## Usage

```typescript
import { Agent, OpenAIProvider, MCPClientWrapper } from '@cloud-llm-hub/llm-agent';

const llmProvider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
});

const mcpClient = new MCPClientWrapper({
  transport: 'stdio',
  command: 'node',
  args: ['path/to/mcp-server.js'],
});

const agent = new Agent({
  llmProvider,
  mcpClient,
});

const response = await agent.process('What tools are available?');
console.log(response.message);
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Development mode
npm run dev
```

## Architecture

- `src/agent.ts` - Core agent orchestrator
- `src/llm-providers/` - LLM provider implementations
- `src/mcp/` - MCP client wrapper
- `src/types.ts` - TypeScript type definitions

## License

MIT
