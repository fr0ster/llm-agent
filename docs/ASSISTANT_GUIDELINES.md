# Assistant Interaction Guidelines

## Language Rules

- Write repository artifacts in English: source, comments, docs, commit messages.
- Reply to the user in the language used in the conversation.

## Current Project Snapshot

- Packages: `@mcp-abap-adt/llm-agent` (contracts: interfaces, types, lightweight helpers), `@mcp-abap-adt/llm-agent-mcp` (MCP client), `@mcp-abap-adt/llm-agent-rag` (RAG/embedder composition), `@mcp-abap-adt/llm-agent-libs` (composition runtime: SmartAgentBuilder, pipeline, skills, ...), `@mcp-abap-adt/llm-agent-server-libs` (SmartServer composition library: pipeline factories, coordinator handlers, config parsing), `@mcp-abap-adt/llm-agent-server` (binary only: CLI + HTTP server)
- Version line: `20.x`
- Main runtime: `SmartAgentBuilder` (in `@mcp-abap-adt/llm-agent-libs`); HTTP server `SmartServer` (in `@mcp-abap-adt/llm-agent-server-libs`, binary in `@mcp-abap-adt/llm-agent-server`)
- Public library exports: `@mcp-abap-adt/llm-agent` (contracts), `@mcp-abap-adt/llm-agent-mcp` (MCP), `@mcp-abap-adt/llm-agent-rag` (RAG), `@mcp-abap-adt/llm-agent-libs` (composition runtime), `@mcp-abap-adt/llm-agent-server-libs` (SmartServer library), `@mcp-abap-adt/llm-agent-libs/testing`, `@mcp-abap-adt/llm-agent-libs/otel`

## Architecture Facts (Keep in Sync)

- `SmartServer` is the HTTP boundary exposing: `POST /v1/chat/completions` (OpenAI-compatible, SSE streaming supported), `POST /v1/messages` (Anthropic-compatible adapter), `GET /v1/models`, `GET /v1/embedding-models`, `GET /v1/usage`, `GET /health` (also `/v1/health`), `GET|DELETE /v1/sessions/:id`, `GET /v1/sessions/:id/resume`, `PUT /v1/config`.
- `SmartAgentBuilder` wires defaults and optional overrides (LLM/RAG/MCP/policy/logger).
- `SmartAgent` runs classification, retrieval, tool loop, and response streaming.
- Pipeline configuration supports `deepseek`, `openai`, `anthropic` providers.
- Current default operational profile in repo docs/config is DeepSeek-first.

## Operational Modes

- `smart`: orchestrated path with classification/RAG/tool loop.
- `hard`: stricter internal-tool context handling.
- `pass`: passthrough behavior.

## Validation and Error Boundaries

- External tools payloads are normalized at the server boundary.
- Validation mode:
  - `permissive` (default): drop invalid tools, continue, emit diagnostics.
  - `strict`: reject request with `400 invalid_request_error`.
- Session-scoped tool unavailability can temporarily suppress broken tools from future context.

## Repository Commands

Root (repo-wide):

- `npm run build` — compile every package
- `npm run dev` — run the server via tsx (hot reload)
- `npm test` — run every workspace's tests
- `npm run lint` / `npm run lint:check` — Biome

Server package (qualify with `--workspace @mcp-abap-adt/llm-agent-server`, or run from `packages/llm-agent-server`):

- `npm run start --workspace @mcp-abap-adt/llm-agent-server` — `node dist/.../cli.js` (build first)
- `npm run test:server --workspace @mcp-abap-adt/llm-agent-server`
- `npm run release:check --workspace @mcp-abap-adt/llm-agent-server` — `tsc --noEmit`

## Documentation Sources of Truth

- Product overview and usage: `README.md`
- Quick start guide: `docs/QUICK_START.md`
- Runtime and contracts: `docs/ARCHITECTURE.md`
- Usage snippets: `docs/EXAMPLES.md`
- Deployment examples: `examples/`

If docs conflict, align them to actual package source behavior and tests (`packages/llm-agent-libs/src/`, `packages/llm-agent/src/`, etc.).
