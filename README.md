# Smart Agent & Server

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

A high-performance, RAG-orchestrated LLM agent and OpenAI-compatible server with deep MCP integration.

## Overview

This project provides a robust orchestration layer that transforms standard LLMs into specialized autonomous agents. It handles multi-turn tool loops, long-term memory via RAG, and serves everything through a standard OpenAI-compatible API.

**Key Components:**
- **SmartAgent:** The core orchestrator that manages intent classification, RAG retrieval, and tool execution loops.
- **SmartServer:** A production-ready HTTP server that makes the agent accessible to any OpenAI-compatible client (Cline, Goose, etc.).
- **Hybrid RAG:** A multi-vector search engine combining semantic embeddings with BM25 lexical scoring.

## Supported API Protocols

SmartServer exposes two inbound API endpoints, both routing through the same SmartAgent pipeline:

- **OpenAI Chat Completions** — `POST /v1/chat/completions` — compatible with Cline, Goose, and any OpenAI SDK
- **Anthropic Messages API** — `POST /v1/messages` — compatible with Claude CLI (Claude Code) and the Anthropic SDK

Protocol translation is handled by `ILlmApiAdapter` — a stateless singleton that normalizes inbound requests and formats outbound responses/streams per-protocol. Custom adapters can be registered via the builder or plugin system.

See [docs/CLIENT_SETUP.md](docs/CLIENT_SETUP.md) for connection instructions for Claude CLI, Cline, and Goose.

## Features

- ✅ **Real Incremental Streaming:** True per-token streaming for both text and tool-call deltas.
- ✅ **OpenAI SSE Compliance:** Fully compatible with official OpenAI SDKs and IDE plugins.
- ✅ **Hybrid RAG Search:** Combines Vector similarity (semantic) with BM25 (lexical) for pinpoint accuracy in technical domains like SAP/ABAP.
- ✅ **Multi-Intent Classification:** Automatically routes requests to `chat` (fast-path), `action` (tool-loop), or long-term memory (`fact`/`state`).
- ✅ **Reasoning Mode:** Optional transparent thought process (`<reasoning>` blocks) to explain agent strategy.
- ✅ **Resilience:** Built-in exponential backoff retries for LLM/Embeddings and auto-reconnect for MCP servers.
- ✅ **Helper LLM Support:** Offload summarization and translation tasks to cheaper/faster models.
- ✅ **Startup Health Checks:** Immediate diagnostics for all dependencies (Ollama, MCP, LLM).

## Installation

```bash
npm install @mcp-abap-adt/llm-agent
```

## Quick Start

1. **Initialize Configuration:**
   Run the agent once to generate the default `smart-server.yaml` template:
   ```bash
   npx llm-agent
   ```

2. **Configure:**
   Edit `smart-server.yaml` and `.env` with your API keys and MCP endpoints.

3. **Launch Server:**
   ```bash
   npm run dev -- --config smart-server.yaml
   ```

## Usage

### Connecting IDE Clients

Point your favorite AI client to your local SmartServer:
- **Base URL:** `http://localhost:4004/v1`
- **Model ID:** `smart-agent`
- **API Key:** (any string, e.g., `sk-none`)

### Intent Types

SmartAgent automatically classifies your input into:
- **Fact:** Technical rules or constraints (e.g., "ABAP Cloud forbids direct table access"). Stored in long-term facts RAG.
- **State:** Project context or temporary observations (e.g., "Kristina approves decisions", "Sky is blue"). Stored in state RAG.
- **Chat:** Trivial questions or math (e.g., "2+2"). Processed via fast-path without project context.
- **Action:** (Default) Engineering tasks requiring tools and deep analysis.

## Advanced Configuration (YAML)

```yaml
port: 4004
host: 0.0.0.0

# Hybrid RAG Settings
rag:
  type: ollama
  url: http://localhost:11434
  vectorWeight: 0.7
  keywordWeight: 0.3

# Multi-model Pipeline
pipeline:
  llm:
    main:
      provider: deepseek
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat
    classifier:
      provider: deepseek
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat
      temperature: 0.1
    helper:
      provider: deepseek
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat  # Used for fast summarization/translation
      temperature: 0.1

# Feature Toggles
agent:
  showReasoning: true     # Enable debug thought blocks
  maxIterations: 10
  historyAutoSummarizeLimit: 15
```

## Development

```bash
# Build project
npm run build

# Run tests
npm run test:all

# Development with hot-reload
npm run dev

# Smart server production entrypoint
npm run start

# Legacy compatibility aliases
npm run start:smart
npm run dev:llm
npm run start:llm
npm run test
npm run test:llm
```

## License

MIT
