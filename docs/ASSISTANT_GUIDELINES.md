# Assistant Interaction Guidelines

## Language Rules

- Write repository artifacts in English: source, comments, docs, commit messages.
- Reply to the user in the language used in the conversation.

## Current Project Snapshot

- Package: `@mcp-abap-adt/llm-agent`
- Version line: `1.1.x beta`
- Main runtime: `src/smart-agent` (`SmartServer` + `SmartAgent`)
- Public embedding export: `@mcp-abap-adt/llm-agent/smart-server`
- Public testing export: `@mcp-abap-adt/llm-agent/testing`

Legacy modules under `src/agents`, `src/llm-providers`, and `src/mcp` are still present for compatibility and adapter reuse.

## Architecture Facts (Keep in Sync)

- `SmartServer` is the OpenAI-compatible HTTP boundary (`/v1/chat/completions`, SSE supported).
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

- `npm run build`
- `npm run dev`
- `npm run start`
- `npm run test:server`
- `npm run test:all`
- `npm run release:check`

## Documentation Sources of Truth

- Product overview and usage: `README.md`
- Runtime and contracts: `docs/ARCHITECTURE.md`
- Usage snippets: `docs/EXAMPLES.md`

If docs conflict, align them to actual `src/smart-agent/*` behavior and tests.
