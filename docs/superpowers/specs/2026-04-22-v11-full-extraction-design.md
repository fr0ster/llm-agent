# v11.0.0 — Complete Provider and Backend Extraction

**Date:** 2026-04-22
**Target release:** v11.0.0 (major, breaking)
**Status:** Draft → In Review
**Builds on:** v10.0.0 (monorepo split)

## Motivation

v10.0.0 split the repository into `@mcp-abap-adt/llm-agent` (core) and `@mcp-abap-adt/llm-agent-server` (runtime), but both packages still ship every provider and every embedder. A consumer who uses only DeepSeek LLM and Ollama embeddings still pulls OpenAI, Anthropic, and SAP AI Core code at runtime.

The original roadmap proposed incremental extraction across 10.1-10.6 minor releases. Review of that approach surfaced fundamental architectural issues:

1. **Back-compat re-exports create cycles.** If core re-exports `OpenAiEmbedder` from `@mcp-abap-adt/openai-embedder`, and openai-embedder imports `IEmbedderBatch` from core, any build order is impossible.
2. **Incremental minors accumulate migration burden.** Consumers face import changes at 10.1, 10.2, 10.3… six rounds of upgrades for one architectural goal.
3. **Architectural decisions (interfaces package, agent-hierarchy removal) don't fit inside minors.**

v11.0.0 does the complete extraction in one release, accepting the breaking change. No back-compat re-exports — clean dependency graph. Consumers migrate imports once, then enjoy minimal dependency surface.

## Scope

### New packages (extracted from monolith)

**LLM providers:**
- `@mcp-abap-adt/openai-llm` — `OpenAIProvider` (+ `OpenAIConfig`)
- `@mcp-abap-adt/anthropic-llm` — `AnthropicProvider` (+ `AnthropicConfig`)
- `@mcp-abap-adt/deepseek-llm` — `DeepSeekProvider` (+ `DeepSeekConfig`). Depends on `openai-llm` because `DeepSeekProvider extends OpenAIProvider`.
- `@mcp-abap-adt/sap-aicore-llm` — `SapCoreAIProvider` (+ `SapCoreAIConfig`). Carries `@sap-ai-sdk/orchestration`.

**Embedders:**
- `@mcp-abap-adt/openai-embedder` — `OpenAiEmbedder` (+ `OpenAiEmbedderConfig`). Native `fetch`, no HTTP client dep.
- `@mcp-abap-adt/ollama-embedder` — `OllamaEmbedder` + `OllamaRag` convenience wrapper.
- `@mcp-abap-adt/sap-aicore-embedder` — `SapAiCoreEmbedder`. Carries `@sap-ai-sdk/foundation-models` (or equivalent).

**Vector backends:**
- `@mcp-abap-adt/qdrant-rag` — `QdrantRag` + `QdrantRagProvider` (+ configs). Carries `axios`.

### Removed from codebase

- **Non-Smart Agent hierarchy** — `BaseAgent`, `OpenAIAgent`, `AnthropicAgent`, `DeepSeekAgent`, `SapCoreAIAgent`, `PromptBasedAgent`, and their `__tests__`. Consumers migrate to `SmartAgent` + a provider directly.
- **`LlmAdapter`** (if it exists solely to wrap Agent classes into `ILlm`). If it has other uses, audit and preserve those.
- **All back-compat re-exports** from v10.0 are REMOVED. `@mcp-abap-adt/llm-agent` no longer exports `OpenAiEmbedder`, `QdrantRag`, etc. `@mcp-abap-adt/llm-agent-server` no longer exports `OpenAIProvider`, `AnthropicProvider`, etc. Each symbol lives in exactly one package.

### Refactored in server

- `cli.ts` — rewritten to use `SmartAgentBuilder` as the only code path. LLM-only mode preserved by building a SmartAgent without MCP (or with `mcp: { disabled: true }`).
- `smart-agent/providers.ts` — simplified to construct concrete `ILlm` from provider classes directly. No `LlmAdapter` / Agent wrapping.
- `smoke-adapters.ts` — adapted to the new provider construction path.

### Core package after v11.0.0

Dependencies: **`zod` only** at runtime. No `axios`, no `@sap-ai-sdk/*`, no HTTP clients.

Content:
- Interfaces (`IRag`, `IRagEditor`, `IRagProvider`, `IRagRegistry`, `IRagBackendWriter`, `ILlm`, `IMcpClient`, `IEmbedder`, `IEmbedderBatch`, etc.)
- Types (`Message`, `ToolCall`, `RagMetadata`, `CallOptions`, `Result`, errors)
- Lightweight RAG implementations: `InMemoryRag`, `VectorRag` (no embedder — accepts `IEmbedder` via constructor), registry, providers (`InMemoryRagProvider`, `VectorRagProvider` — `QdrantRagProvider` moves out), edit/id strategies, corrections module, overlays (`OverlayRag`, `SessionScopedRag`), wrappers (`ActiveFilteringRag`, `ExpositionFilteringRag` if present), MCP tool factory, errors.
- `OllamaRag` convenience class — moves to `@mcp-abap-adt/ollama-embedder` since it's purely Ollama-specific.

### Server package after v11.0.0

Dependencies: `@mcp-abap-adt/llm-agent`, `@modelcontextprotocol/sdk`, `yaml`, `dotenv`, `zod`. Plus any "default" LLM provider packages that its built-in CLI/HTTP-server needs out of the box (see Q5 below in open items).

Content:
- `SmartAgent`, `SmartAgentBuilder`, `DefaultPipeline`, pipeline handlers
- MCP client (`MCPClientWrapper` + transports)
- Resilience wrappers (`FallbackRag`, `CircuitBreaker`, `RetryLlm`, `RateLimiterLlm`, `CircuitBreakerLlm`)
- Skill managers (`ClaudeSkillManager`, `CodexSkillManager`, `FileSystemSkillManager`)
- CLI + HTTP server + config loading
- Observability (tracer, metrics, otel)
- Adapters, API adapters, cache, session, testing helpers

## Dependency graph (final)

```
@mcp-abap-adt/llm-agent (zod)
  ↑  ↑  ↑  ↑  ↑  ↑  ↑  ↑
  │  │  │  │  │  │  │  │
  ├─ openai-llm
  ├─ anthropic-llm
  ├─ deepseek-llm ── openai-llm
  ├─ sap-aicore-llm (@sap-ai-sdk/orchestration)
  ├─ openai-embedder
  ├─ ollama-embedder
  ├─ sap-aicore-embedder (@sap-ai-sdk/foundation-models)
  ├─ qdrant-rag (axios)
  │
  └─ llm-agent-server (modelcontextprotocol-sdk, yaml, dotenv + default LLM providers)
```

Every arrow goes UP to core. No back-pointers. No cycles.

## Resolved questions

| # | Question | Decision |
|---|---|---|
| 1 | One release vs six incremental minors | **One major (v11.0.0).** Refactoring batched, single migration for consumers. |
| 2 | Back-compat re-exports from core/server | **Removed.** Each symbol lives in exactly one package. Breaking change — semver-major. |
| 3 | Non-Smart Agent hierarchy (OpenAIAgent etc.) | **Removed.** Consumers migrate to SmartAgent. `cli.ts` rewritten to use SmartAgentBuilder exclusively. |
| 4 | Resilience wrappers (FallbackRag etc.) | **Stay in server.** Runtime-side, not core abstraction. |
| 5 | RAG wrappers (ActiveFilteringRag etc.) | **Stay in core.** Pure logic, no SDK deps. |
| 6 | Default in-process backends (InMemoryRag, VectorRag) | **Stay in core.** No external SDKs. |
| 7 | OllamaRag convenience wrapper | **Moves to ollama-embedder package.** Purely Ollama-specific. |
| 8 | Publish mechanics | `npx changeset publish` — all packages in dependency order from one command. |
| 9 | Changesets `fixed` group | All nine packages (core, server, 4 LLMs, 3 embedders, qdrant-rag) in lock-step for the 11.x lifecycle. |

## Package layouts

Each new package follows the same template:

```
packages/<name>/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts
    ├── <impl>.ts
    └── __tests__/ (moves with code)
```

`tsconfig.json` for each new package:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2022", "DOM"],
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["**/__tests__/**", "**/*.test.ts", "dist"],
  "references": [{ "path": "../llm-agent" }]
}
```

`deepseek-llm` additionally references `../openai-llm`.

`package.json` template:

```json
{
  "name": "@mcp-abap-adt/<name>",
  "version": "11.0.0",
  "description": "<concise description>",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "tsc -p tsconfig.json --clean",
    "test": "node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'"
  },
  "dependencies": {
    "@mcp-abap-adt/llm-agent": "*"
    // plus package-specific runtime deps listed below
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/fr0ster/llm-agent.git"
  },
  "publishConfig": { "access": "public" }
}
```

### Per-package runtime dependencies beyond core

| Package | Runtime deps |
|---|---|
| `openai-llm` | `axios` |
| `anthropic-llm` | `axios` |
| `deepseek-llm` | `@mcp-abap-adt/openai-llm: "*"` (no axios; inherits from openai-llm) |
| `sap-aicore-llm` | `@sap-ai-sdk/orchestration` |
| `openai-embedder` | (none; native fetch) |
| `ollama-embedder` | (none; native fetch) |
| `sap-aicore-embedder` | `@sap-ai-sdk/foundation-models` or equivalent (verify against current imports) |
| `qdrant-rag` | `axios` |

## Root build

Update root `package.json`:

```json
{
  "scripts": {
    "prebuild": "npm run --workspace @mcp-abap-adt/llm-agent-server prebuild",
    "build": "tsc -b packages/llm-agent packages/openai-llm packages/anthropic-llm packages/deepseek-llm packages/sap-aicore-llm packages/openai-embedder packages/ollama-embedder packages/sap-aicore-embedder packages/qdrant-rag packages/llm-agent-server",
    "clean": "tsc -b --clean packages/llm-agent packages/openai-llm packages/anthropic-llm packages/deepseek-llm packages/sap-aicore-llm packages/openai-embedder packages/ollama-embedder packages/sap-aicore-embedder packages/qdrant-rag packages/llm-agent-server"
  }
}
```

Order: core first, then provider/embedder/qdrant packages (all depend only on core), `deepseek-llm` implicitly after `openai-llm` via TS project reference, server last.

## Changes to existing packages

### `@mcp-abap-adt/llm-agent` (core)

- Delete `src/rag/openai-embedder.ts`, `src/rag/ollama-rag.ts`, `src/rag/qdrant-rag.ts`, `src/rag/qdrant-rag-provider.ts`.
- Update `src/rag/embedder-factories.ts` — remove imports of moved embedders. Consumer-side factories register what they need.
- Update `src/rag/index.ts` barrel — no more re-exports of moved classes. Wildcard barrels that covered `openai-embedder.ts` etc. must be trimmed.
- Update `src/index.ts` — no more re-exports of moved symbols.
- Drop dependencies on `axios` and `@sap-ai-sdk/orchestration`.

### `@mcp-abap-adt/llm-agent-server` (server)

- Delete `src/llm-providers/` directory (LLM providers moved out).
- Delete `src/agents/` directory (Agent hierarchy removed).
- Rewrite `src/smart-agent/cli.ts` — single path: parse args, build `SmartAgent`, run. No Agent instantiation.
- Rewrite `src/smart-agent/providers.ts` — construct concrete `ILlm` by constructing the provider directly (import from `@mcp-abap-adt/openai-llm` etc. based on `LLM_PROVIDER` env). No wrapping.
- Remove `LlmAdapter` if only used for Agent wrapping.
- Update `src/index.ts` — no more re-exports of LLM providers.
- Update `src/smart-agent/__tests__/` and other tests — replace any `new OpenAIAgent(...)` with `new OpenAIProvider(...)` (for LLM-only tests) or SmartAgent patterns.
- Update `smoke-adapters.ts` — same refactor.
- Add dependencies on the LLM provider packages that the default CLI/HTTP server needs out of the box. See Q5 below.

## Changesets configuration

```json
{
  "fixed": [
    [
      "@mcp-abap-adt/llm-agent",
      "@mcp-abap-adt/llm-agent-server",
      "@mcp-abap-adt/openai-llm",
      "@mcp-abap-adt/anthropic-llm",
      "@mcp-abap-adt/deepseek-llm",
      "@mcp-abap-adt/sap-aicore-llm",
      "@mcp-abap-adt/openai-embedder",
      "@mcp-abap-adt/ollama-embedder",
      "@mcp-abap-adt/sap-aicore-embedder",
      "@mcp-abap-adt/qdrant-rag"
    ]
  ]
}
```

One changeset file documents the v11.0.0 release; all ten packages bump to 11.0.0 in lock-step.

## Migration for consumers — `docs/MIGRATION-v11.md`

Comprehensive table of every moved / renamed / removed symbol. High-level sections:

1. **What broke:** back-compat re-exports gone. Agent hierarchy gone.
2. **Install changes:** install the specific provider/embedder packages you use.
3. **Symbol → package** mapping table (every moved symbol).
4. **Agent hierarchy removal:** before/after code snippets showing `new OpenAIAgent(...)` → `new OpenAIProvider(...)` + SmartAgent pattern.
5. **CLI changes:** `llm-agent --llm-only` still works; internally backed by SmartAgent without MCP rather than the old Agent classes.
6. **Docker examples:** `Dockerfile` in `examples/docker-*` updated to install the needed provider packages explicitly.
7. **Light-install recipes:**
   - "DeepSeek + Ollama" minimal set: `llm-agent-server`, `deepseek-llm`, `ollama-embedder`.
   - "OpenAI + Qdrant": `llm-agent-server`, `openai-llm`, `openai-embedder`, `qdrant-rag`.
   - "SAP AI Core everywhere": `llm-agent-server`, `sap-aicore-llm`, `sap-aicore-embedder`, `qdrant-rag` (SAP AI Core doesn't own a vector store).

## Testing

- Tests move with their code into the respective new packages.
- Core tests continue to pass; core loses provider-specific tests.
- Server tests updated for new composition patterns.
- Workspace-level `npm test` runs all ten packages.
- CI already sets up Node 22 + workspace-aware scripts (no change needed).

## Docs updates

- `README.md` — monorepo index, adds sections for all ten packages.
- `docs/QUICK_START.md` — install commands for representative stacks.
- `docs/ARCHITECTURE.md` — dependency graph diagram, component responsibilities.
- `docs/INTEGRATION.md` — import paths throughout.
- `docs/EXAMPLES.md` — example code updated.
- `docs/DEPLOYMENT.md` — Dockerfile patterns updated.
- Per-package `README.md` for each new package.
- Delete v10-era migration docs (`MIGRATION-v10.md`, `MIGRATION-v10.1.md` if it existed) — v11 migration supersedes them.

## Release flow

1. Implement all extractions and refactors (plan has separate tasks for each package).
2. Full workspace build + test green.
3. `npx changeset` — write one changeset file covering all ten packages.
4. `npx changeset version` → all ten packages at 11.0.0; per-package CHANGELOG.md updated.
5. Merge PR.
6. Post-merge: `npx changeset publish` — publishes all ten packages in dep order with one command.
7. Tag `v11.0.0`, push — GitHub release workflow creates the release page.

## Known items for the implementation plan

- **CLI LLM-only mode implementation:** current `cli.ts` uses Agent classes for LLM-only. After refactor, it must build a `SmartAgent` with MCP disabled. Confirm that pipeline handles "no MCP" gracefully (it should, since MCP was optional in v10). If not, pipeline config gains an explicit `mcp: { disabled: true }` branch.
- **`LlmAdapter`:** audit whether it's used only for wrapping Agents, or also for other shims. Preserve non-Agent uses.
- **`smoke-adapters.ts`:** rewrite to exercise the new provider path. May become trivial or obsolete.
- **SAP AI Core package split:** if `sap-aicore-llm` and `sap-aicore-embedder` share common credentials/config utilities, decide whether to hoist those to a fourth package `sap-aicore-common` or duplicate into both. Lean: duplicate for simplicity; deduplicate in a future minor if repetition becomes painful.
- **Package naming for embedders inherited via VectorRag config:** `VectorRag` in core accepts any `IEmbedder` via its constructor — no hard-coded dependency on a specific embedder package. Verify that consumer recipes pass embedder instances rather than relying on factory lookup in core.
- **Default LLM package shipped by server:** does `@mcp-abap-adt/llm-agent-server` list any LLM provider package as a runtime dependency so that `smart-server.yaml`'s default config works out of the box? If yes, which one? Options: none (consumer must install + configure explicitly), or `openai-llm` as the widest-default. Lean: **none** — server's package.json lists only the MCP/yaml/dotenv deps it needs; consumer installs providers for their stack. `docs/MIGRATION-v11.md` calls this out explicitly.

## Future follow-ups (not in v11)

- `ollama-llm` if/when we add an Ollama LLM class (currently there isn't one).
- `@mcp-abap-adt/hana-vector-provider` — SAP HANA Cloud Vector Engine. Separate project; may live in a different repo given its SAP-specific dependencies.
- Formal "recipes" as meta-packages (e.g. `@mcp-abap-adt/deepseek-ollama-stack` that depends on the right packages). Low priority — consumers install directly.
