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

Dependencies: `@mcp-abap-adt/llm-agent`, `@modelcontextprotocol/sdk`, `yaml`, `dotenv`, `zod`, plus the provider packages that the built-in declarative config path needs to resolve by name. Specifically, server's `builtInEmbedderFactories` and LLM provider factory registry accept names like `openai`, `ollama`, `sap-ai-core`, `deepseek` and must instantiate the corresponding classes. Since those factories now live on `llm-agent-server`, it must depend on every package it can instantiate:

- `@mcp-abap-adt/openai-llm`
- `@mcp-abap-adt/anthropic-llm`
- `@mcp-abap-adt/deepseek-llm`
- `@mcp-abap-adt/sap-aicore-llm`
- `@mcp-abap-adt/openai-embedder`
- `@mcp-abap-adt/ollama-embedder`
- `@mcp-abap-adt/sap-aicore-embedder`
- `@mcp-abap-adt/qdrant-rag`

This keeps the "install `llm-agent-server` and everything in `smart-server.yaml` just works" promise. Consumers who write their own code against the interfaces and skip the server package are free to install only the provider packages they actually use.

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

- Delete `src/rag/openai-embedder.ts`, `src/rag/ollama-embedder.ts`, `src/rag/ollama-rag.ts`, `src/rag/qdrant-rag.ts`, `src/rag/qdrant-rag-provider.ts`, `src/rag/sap-ai-core-embedder.ts`.
- **Move `src/rag/embedder-factories.ts` to server** at `packages/llm-agent-server/src/smart-agent/embedder-factories.ts`. The factory registry is a declarative wiring layer, not a core abstraction — each factory imports the concrete class from the corresponding new package, so the registry must live in a package that depends on all provider packages. Server is the only package that does.
- Update `src/rag/index.ts` barrel — no more re-exports of moved classes.
- Update `src/index.ts` — no more re-exports of moved symbols or factories.
- Drop dependencies on `axios` and `@sap-ai-sdk/orchestration`.

### `@mcp-abap-adt/llm-agent-server` (server)

- Delete `src/llm-providers/` directory (LLM providers moved out).
- Delete `src/agents/` directory (Agent hierarchy removed).
- Rewrite `src/smart-agent/cli.ts` — single path: parse args, build `SmartAgent`, run. No Agent instantiation. **LLM-only mode preserves the existing contract:** `smart-server.yaml` sets `mcp.type: 'none'`; config resolution and `SmartServer` composition interpret that as "build `SmartAgentBuilder` without MCP" (i.e., omit the MCP config argument the builder would otherwise receive). `SmartAgentBuilderConfig` itself is not changed. The v11 refactor touches neither config schema nor builder MCP type.
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
7. **Install modes — choose one:**

   **a) Batteries-included (server as runtime):**
   ```bash
   npm install @mcp-abap-adt/llm-agent-server
   ```
   Pulls every provider/embedder/qdrant package transitively. `smart-server.yaml` declarative config (`llm: deepseek`, `rag: ollama`, etc.) resolves any name out of the box. Recommended for most deployments that just run the CLI / HTTP server.

   **b) Library-only (minimal footprint):**
   Install core plus ONLY the specific provider packages your code imports directly. You build `SmartAgent` programmatically with `SmartAgentBuilder`, supplying provider instances to fluent setters. Example "DeepSeek LLM + Ollama embeddings":
   ```bash
   npm install @mcp-abap-adt/llm-agent @mcp-abap-adt/deepseek-llm @mcp-abap-adt/ollama-embedder
   ```
   No SAP SDK, no OpenAI packages (DeepSeek transitively pulls `openai-llm` because it extends OpenAIProvider, which is the only exception).

   Library-only consumers write their own composition code; they don't get the declarative `smart-server.yaml` factory resolution — they pass provider instances directly to the builder.

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

- **CLI LLM-only mode implementation:** uses the existing `mcp.type: 'none'` config branch (confirmed present in v10 builder code). No new flag. Builder + `cli.ts` rewrite preserve this contract. Plan task includes verifying the `none` path is wired all the way through pipeline construction.
- **`LlmAdapter`:** audit whether it's used only for wrapping Agents, or also for other shims. Preserve non-Agent uses. If it only wraps Agents, delete along with the Agent hierarchy.
- **`smoke-adapters.ts`:** rewrite to exercise the new provider path. May become trivial or obsolete.
- **SAP AI Core package split:** if `sap-aicore-llm` and `sap-aicore-embedder` share common credentials/config utilities, decide whether to hoist those to a fourth package `sap-aicore-common` or duplicate into both. Lean: duplicate for simplicity; deduplicate in a future minor if repetition becomes painful.
- **Embedder factory registry location:** moves to server (see "Changes to existing packages → core" above). Each factory entry imports the concrete embedder class from its new package. Server's `resolveEmbedder()` continues to work with names like `ollama`, `openai`, `sap-ai-core` via the relocated registry.
- **Config-template defaults align with server deps:** because server now depends on all provider and embedder packages, the generated `smart-server.yaml` template can continue to default to `llm: deepseek`, `rag: ollama`, etc., without a broken fresh-install experience. Plan task includes a dedicated check that `smart-server.yaml`'s defaults resolve against server's dependency list.

## Future follow-ups (not in v11)

- `ollama-llm` if/when we add an Ollama LLM class (currently there isn't one).
- `@mcp-abap-adt/hana-vector-provider` — SAP HANA Cloud Vector Engine. Separate project; may live in a different repo given its SAP-specific dependencies.
- Formal "recipes" as meta-packages (e.g. `@mcp-abap-adt/deepseek-ollama-stack` that depends on the right packages). Low priority — consumers install directly.

## Review notes and proposals

- **Observation:** the current "lean: none" decision for provider packages shipped by `@mcp-abap-adt/llm-agent-server` conflicts with the documented default CLI/server experience. The generated config template still defaults to DeepSeek for `llm` and Ollama for `rag`, and `SmartServer` currently resolves those defaults automatically. **Proposal:** either keep a minimal default provider/embedder set as runtime dependencies of `llm-agent-server`, or redesign the generated config/template so a fresh install never references providers the server package does not ship.
- **Observation:** removing built-in embedder factories from core without naming a new owner creates a gap in declarative YAML-driven RAG resolution. Today `resolveEmbedder()` in server depends on `builtInEmbedderFactories`, and configs use names like `ollama`, `openai`, and `sap-ai-core`. **Proposal:** explicitly move the built-in factory registry to `llm-agent-server` (or to a dedicated defaults package) together with the runtime dependencies needed to instantiate those embedders.
- **Observation:** the proposed "SmartAgent without MCP (or with `mcp: { disabled: true }`)" path is not aligned with the current builder/config contract. The builder currently models MCP as `http | stdio`, while config disabling is represented as `mcp.type: none`. **Proposal:** either keep `mcp.type: none` as the v11 mechanism, or specify `disabled: true` as an intentional config/API change with matching builder and config updates.
- **Observation:** the corrected spec now says LLM-only mode uses the existing `mcp.type: 'none'` path and that this is "already supported by the builder", but in the current code `none` is handled in config resolution and SmartServer composition, not in `SmartAgentBuilderConfig` itself. **Proposal:** reword that section to say v11 preserves the existing `config -> SmartServer -> omitted builder MCP config` contract, instead of claiming direct builder support for `none`.
- **Observation:** the migration "light-install recipes" are now inconsistent with the updated server dependency model. If `llm-agent-server` depends on all provider/embedder packages needed by named declarative config, then recipes like `llm-agent-server + deepseek-llm + ollama-embedder` are not actually minimal for server users. **Proposal:** split migration guidance into two explicit modes: `llm-agent-server` as a batteries-included install, and library-only usage where consumers install only the specific provider/embedder packages they instantiate directly.
