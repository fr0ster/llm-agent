# Smart Agent & Server

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

A high-performance, RAG-orchestrated LLM agent and OpenAI-compatible server with deep MCP integration.

## Packages

| Package | What it is |
|---|---|
| [`@mcp-abap-adt/llm-agent`](packages/llm-agent/README.md) | Interfaces, types, and lightweight default RAG implementations. |
| [`@mcp-abap-adt/llm-agent-server`](packages/llm-agent-server/README.md) | Default SmartAgent, pipeline, LLM providers, MCP client, HTTP server, and CLIs. Depends on `@mcp-abap-adt/llm-agent`. |

## Quick install

```bash
# Default runtime (most common)
npm install @mcp-abap-adt/llm-agent-server

# Writing your own agent on our interfaces
npm install @mcp-abap-adt/llm-agent
```

See `docs/MIGRATION-v10.md` if you are upgrading from a v9 install.

## Documentation

- [QUICK_START.md](docs/QUICK_START.md) — end-to-end guide: install, config, connect IDE
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture reference: thin proxy layer + SmartAgent/SmartServer/pipeline
- [INTEGRATION.md](docs/INTEGRATION.md) — custom interface implementation guide with code examples
- [PERFORMANCE.md](docs/PERFORMANCE.md) — RAG, BM25, model selection, token budget tuning
- [CLIENT_SETUP.md](docs/CLIENT_SETUP.md) — connection instructions for Claude CLI, Cline, and Goose
- [SAP_AI_CORE.md](docs/SAP_AI_CORE.md) — SAP AI Core operational guidance and troubleshooting
- [DEPLOYMENT.md](docs/DEPLOYMENT.md) — production deployment patterns (Docker, systemd, serverless)

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
