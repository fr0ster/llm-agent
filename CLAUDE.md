# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Compile TypeScript → dist/
npm run dev            # Run CLI with MCP via tsx (hot reload)
npm run lint           # Lint & auto-fix with Biome
npm run lint:check     # Check lint without fixing
npm run format         # Format with Biome
npm run clean          # Remove dist/
```

There is no unit test framework. `npm run test` is just `build + start` (smoke test).

## Architecture

This monorepo publishes six npm packages forming the SmartAgent runtime:

```
@mcp-abap-adt/llm-agent             contracts: interfaces, public types, lightweight helpers
@mcp-abap-adt/llm-agent-mcp         MCP client wrapper + adapter + connection strategies
@mcp-abap-adt/llm-agent-rag         RAG/embedder composition (makeRag, resolveEmbedder, factories)
@mcp-abap-adt/llm-agent-libs        core composition: builder, agent, pipeline, sessions, ...
@mcp-abap-adt/llm-agent-server-libs SmartServer composition library: build-stepper-root, DAG/stepper
                                    coordinator handlers, config parsing, sessions, pipeline factories
@mcp-abap-adt/llm-agent-server      binary only (CLI + HTTP server, no library exports)
```

Dependency order: `llm-agent-server → llm-agent-server-libs → llm-agent-libs → {llm-agent-mcp, llm-agent-rag} → llm-agent`.

LLM provider, embedder, and RAG backend packages are bundled as regular
dependencies of `@mcp-abap-adt/llm-agent-server` so `npm install -g
@mcp-abap-adt/llm-agent-server` works out-of-the-box. Selection happens
via YAML/CLI config. (At the lower `llm-agent-libs` / `llm-agent-rag`
package level they remain optional peers — embed-as-library users
still install only what they need.)

### Key API notes

- `makeLlm` / `makeDefaultLlm` (in `llm-agent-libs`) → **async** `Promise<ILlm>`
- `makeRag` (in `llm-agent-rag`) → **async** `Promise<IRag>`
- `resolveEmbedder` (in `llm-agent-rag`) → sync (call `prefetchEmbedderFactories` once at startup)
- `SmartAgentBuilder.build()` → async (unchanged externally)

### Key layers

| Layer | Package | Role |
|-------|---------|------|
| **Interfaces & types** | `@mcp-abap-adt/llm-agent` | All `I*` interfaces, shared types, lightweight helpers (CircuitBreaker, FallbackRag, LLM call strategies, ToolCache, adapters, normalizers) |
| **MCP client** | `@mcp-abap-adt/llm-agent-mcp` | `MCPClientWrapper`, `McpClientAdapter`, connection strategies |
| **RAG/embedder** | `@mcp-abap-adt/llm-agent-rag` | `makeRag`, `resolveEmbedder`, prefetch helpers, backend factories |
| **Composition runtime** | `@mcp-abap-adt/llm-agent-libs` | `SmartAgentBuilder`, `SmartAgent`, pipeline, sessions, history, metrics, skills, plugins, `makeLlm` |
| **SmartServer library** | `@mcp-abap-adt/llm-agent-server-libs` | `SmartServer`, `buildFromComposition`/`buildStepperRoot`, `StepperCoordinatorHandler`, config parsing, sessions, and the **pipeline builder-factories** (`LinearFactory`, `DagFactory`, `CyclicFactory`, `PlannedFactory`, `DeepStepperFactory`, `ControllerFactory`) |
| **Binary** | `@mcp-abap-adt/llm-agent-server` | CLI (`llm-agent`, `llm-agent-check`, `claude-via-agent`) + HTTP listen; thin wrapper over `llm-agent-server-libs` |

### MCP transports

`MCPClientConfig.transport` values: `stdio` | `sse` | `stream-http` | `embedded` | `auto`
`auto` detects transport from URL patterns. `embedded` injects an in-process server (used for testing).

## Architecture Principles (MUST verify at every brainstorm AND every review)

**Canonical source: [`docs/ARCHITECTURE.md` → Architecture Principles](docs/ARCHITECTURE.md#architecture-principles)** (keep the two in sync). These are binding. Before finalizing any design (brainstorm) and before approving any change (review), explicitly check the work against each one and state how it complies.

1. **Build ON existing components — never bespoke glue in the app.** Find the
   component that already does it; if it falls short, **rework/extend the component**
   so the fix lands in the reusable library, not in app-local code.
2. **The app IS the example.** `@mcp-abap-adt/llm-agent-server` / `SmartServer` must be
   a working demonstration of *consuming* the libraries. If the app is full of bespoke
   logic, we are proving we don't use our own components — so nobody else will.
   *Corollary:* the answer to an over-grown file is NOT to carve it into ad-hoc
   fragments — it is to **reimplement on the components**.
3. **Everything is built around interfaces.** Consumers depend on interfaces, not
   concrete classes.
4. **Many small interfaces > one big one (ISP).** ADD a new focused interface; do NOT
   grow an existing one. (e.g. a separate `IReadinessReporter`, not an `isReady?()`
   bolted onto `IMcpConnectionStrategy`.)
5. **Variation points the consumer should own → STRATEGIES.** Anything we want to leave
   to the consumer's choice is expressed as a strategy they can swap/implement.
6. **Control file size — no multi-thousand-line files.** A giant file is itself a smell;
   put new logic in a small focused module and consume it (don't append to a god-object).
7. **Don't break components.** Extend additively / backward-compatibly.

## Language

- All artifacts (code, comments, docs, commit messages) must be written in **English**.
- Communicate with the user in the **language they used** in their message.

### MCP tool-RAG language constraint (standing — do not drop)

- **MCP tool selection is English-on-English.** Tool selection is a semantic search
  over the MCP catalog; for stable selection regardless of the user's language BOTH
  sides are English:
  - **MCP tool names/descriptions are translated to English at catalog-build time**
    (build-time concern; the controller does NO runtime translation of descriptions).
  - **The tool-search text is English at search time** — the planner emits step
    `instructions` (and `requires`) in English (hard prompt invariant), so the query
    fed to tool selection is already English. Any other caller of tool search must
    translate its query text to English first.
- **The results-RAG embedder need NOT be multilingual** — a normal embedder is fine.
  Recall/evidence/relevant-extract rank by embedding, but the language requirement is
  the MCP tool-RAG's, not results-RAG's. (Embedding, not a homemade ASCII/lexical
  scorer, is still the ranking mechanism.)
- The finalizer answers in the **user's language**.

## Conventions

- **ESM only** — `"type": "module"` in package.json; use `.js` extensions in imports
- **Biome** for lint/format (not ESLint/Prettier): 2 spaces, single quotes, always semicolons
- **Conventional Commits**: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`
- TypeScript strict mode; avoid `any` (Biome warns)
- Node ≥ 22 required (CI runs on 22 and 24)

## Environment

Copy `.env.template` to `.env`. Key variables:

| Variable | Purpose |
|----------|---------|
| `LLM_PROVIDER` | `openai` / `anthropic` / `deepseek` / `sap-ai-sdk` / `ollama` |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY` | Provider credentials |
| `AICORE_SERVICE_KEY` | SAP AI Core service key JSON (for `sap-ai-sdk` provider) |
| `SAP_AI_MODEL`, `SAP_AI_RESOURCE_GROUP` | SAP AI SDK model name and resource group |
| `MCP_ENDPOINT` | MCP server URL (default: `http://localhost:4004/mcp/stream/http`) |
| `DEBUG_LLM_REASON` | `true` to log LLM reasoning |

> To run without MCP, omit the `mcp:` block or set `mcp.type: none` in `smart-server.yaml`.

## Docs

- `docs/QUICK_START.md` — end-to-end guide: install, config, connect IDE
- `docs/ARCHITECTURE.md` — architecture reference: thin proxy layer + SmartAgent/SmartServer/pipeline
- `docs/EXAMPLES.md` — YAML config examples and programmatic usage snippets
- `src/mcp/README.md` — MCP transport configuration details
- `docs/DEPLOYMENT.md` — production deployment patterns (Docker, systemd, serverless)
- `docs/PERFORMANCE.md` — RAG, BM25, model selection, token budget tuning
- `docs/INTEGRATION.md` — custom interface implementation guide with code examples
- `docs/TROUBLESHOOTING.md` — symptom→cause→fix index for SAP AI Core / Qdrant / pipeline-mode issues
- `examples/docker-ollama/` — Docker Compose, fully local (Ollama LLM + embeddings, no API keys)
- `examples/docker-deepseek/` — Docker Compose, DeepSeek LLM + Ollama embeddings
- `examples/docker-sap-ai-core/` — Docker Compose, SAP AI Core (LLM + embeddings + Qdrant + compat layer)

## Plans and Specs

Plans under `docs/superpowers/plans/` and specs under `docs/superpowers/specs/` are kept in the tree only while active — i.e. not yet implemented and not cancelled. Once a plan/spec has been fully implemented OR cancelled, delete the file. History lives in git; these directories hold only work in progress.
