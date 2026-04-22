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

- `cli.ts` — rewritten to use `SmartAgentBuilder` as the only code path. LLM-only mode preserved through the existing `mcp.type: 'none'` contract at the config-resolution / `SmartServer` composition layer; `SmartAgentBuilder` itself sees the absence of an MCP config argument.
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

**Required runtime dependencies:** `@mcp-abap-adt/llm-agent`, `@modelcontextprotocol/sdk`, `yaml`, `dotenv`, `zod`.

**Optional peer dependencies** (declarative factory registry resolves names to classes; each peer covers one factory name):

```json
"peerDependencies": {
  "@mcp-abap-adt/openai-llm": "^11.0.0",
  "@mcp-abap-adt/anthropic-llm": "^11.0.0",
  "@mcp-abap-adt/deepseek-llm": "^11.0.0",
  "@mcp-abap-adt/sap-aicore-llm": "^11.0.0",
  "@mcp-abap-adt/openai-embedder": "^11.0.0",
  "@mcp-abap-adt/ollama-embedder": "^11.0.0",
  "@mcp-abap-adt/sap-aicore-embedder": "^11.0.0",
  "@mcp-abap-adt/qdrant-rag": "^11.0.0"
},
"peerDependenciesMeta": {
  "@mcp-abap-adt/openai-llm": { "optional": true },
  "@mcp-abap-adt/anthropic-llm": { "optional": true },
  "@mcp-abap-adt/deepseek-llm": { "optional": true },
  "@mcp-abap-adt/sap-aicore-llm": { "optional": true },
  "@mcp-abap-adt/openai-embedder": { "optional": true },
  "@mcp-abap-adt/ollama-embedder": { "optional": true },
  "@mcp-abap-adt/sap-aicore-embedder": { "optional": true },
  "@mcp-abap-adt/qdrant-rag": { "optional": true }
}
```

**Factory registry behavior** (both LLM and embedder): on startup, `resolveEmbedder('ollama')` / `resolveLlm('deepseek')` attempts a dynamic `import('@mcp-abap-adt/ollama-embedder')` etc. If the peer is not installed, the registry throws a typed error like `MissingProviderError('ollama-embedder is declared in config but not installed; run `npm install @mcp-abap-adt/ollama-embedder`')`. Config validation up front can catch this before pipeline boot.

**Consumer install mental model (single contract — no "batteries-included"):** installing `@mcp-abap-adt/llm-agent-server` alone gives you `SmartAgent`, `SmartAgentBuilder`, the HTTP server, the CLI, MCP client, resilience, skills, and the factory registry — but **no** provider/embedder classes. For anything the config names (`llm: deepseek`, `rag: ollama`, etc.), the consumer must install the corresponding peer package explicitly. Missing peer → `MissingProviderError` at resolve time with a clear install hint.

This means the old "batteries-included" promise is gone. In exchange, every consumer's `node_modules` contains exactly what their config uses.

For Docker examples, `Dockerfile`s install server + the specific peers the bundled `smart-server.yaml` names. A future minor may ship a convenience meta-package `@mcp-abap-adt/llm-agent-server-all` whose only purpose is to list all peer packages as direct `dependencies` — opt-in only.

Content:
- `SmartAgent`, `SmartAgentBuilder`, `DefaultPipeline`, pipeline handlers
- MCP client (`MCPClientWrapper` + transports)
- Resilience wrappers (`FallbackRag`, `CircuitBreaker`, `RetryLlm`, `RateLimiterLlm`, `CircuitBreakerLlm`)
- Skill managers (`ClaudeSkillManager`, `CodexSkillManager`, `FileSystemSkillManager`)
- CLI + HTTP server + config loading
- Observability (tracer, metrics, otel)
- Adapters, API adapters, cache, session, testing helpers
- Relocated factory registry (`builtInEmbedderFactories` + LLM factory equivalent) with dynamic-import / missing-peer error handling

## Dependency graph (final)

```
@mcp-abap-adt/llm-agent (zod)
  ↑
  │
  ├─ openai-llm          ←─ optional peer of llm-agent-server
  ├─ anthropic-llm       ←─ optional peer of llm-agent-server
  ├─ deepseek-llm ── openai-llm
  ├─ sap-aicore-llm (@sap-ai-sdk/orchestration)
  ├─ openai-embedder
  ├─ ollama-embedder
  ├─ sap-aicore-embedder (@sap-ai-sdk/foundation-models)
  ├─ qdrant-rag (axios)
  │
  └─ llm-agent-server (modelcontextprotocol-sdk, yaml, dotenv)
      ↑
      │ optional peer deps: each provider/embedder/qdrant package
      │ (factory registry dynamically imports what the config requests;
      │ missing peer → typed MissingProviderError)
```

Every arrow goes UP to core. No back-pointers. No cycles. Server's provider-package relationships are optional peer deps, not hard `dependencies`, so consumers install only what they use.

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
- **Move `src/rag/embedder-factories.ts` to server** at `packages/llm-agent-server/src/smart-agent/embedder-factories.ts`. The factory registry is a declarative wiring layer, not a core abstraction. Each factory dynamic-imports the concrete class from the corresponding optional peer package; if the peer is not installed, the registry throws `MissingProviderError`. Server is the only package that declares those peers, so the registry belongs there.
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
- Declare every provider/embedder/qdrant package as an **optional peer dependency** (see "Server package after v11.0.0"). Do NOT add them as hard `dependencies`. Consumers install the peers their `smart-server.yaml` names; missing peer = typed error at resolve time.

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

   **a) Server-managed (declarative `smart-server.yaml`):**
   ```bash
   # Server runtime + only the peers your config names.
   npm install @mcp-abap-adt/llm-agent-server \
               @mcp-abap-adt/deepseek-llm \
               @mcp-abap-adt/ollama-embedder
   ```
   `smart-server.yaml` names like `llm: deepseek`, `rag: ollama` resolve via server's factory registry. Missing peer → `MissingProviderError` at startup with an install hint. Recommended for most deployments.

   **b) Programmatic server composition (imperative builder):**
   Same install as (a), but your code constructs `SmartAgent` via `SmartAgentBuilder` directly (no declarative config). Consumer imports `new DeepSeekProvider({...})` from `@mcp-abap-adt/deepseek-llm` and passes the instance to the builder's fluent setters. Factory registry is not involved.

   **c) Core-only (no SmartAgent, no server):**
   ```bash
   npm install @mcp-abap-adt/llm-agent
   ```
   You build your own agent against the interfaces exported by core. Useful when writing a specialized runtime that doesn't need SmartAgent/Builder/pipeline. No provider packages required — you supply your own `ILlm` and `IEmbedder` implementations (or construct third-party provider instances directly from their packages).

   **Install footprint comparison:**
   - (a) + DeepSeek + Ollama peers only: no SAP SDK, no Anthropic on disk. DeepSeek transitively pulls `openai-llm` because it extends `OpenAIProvider` (the only inheritance edge).
   - (c) with your own stubs: just `zod`.

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

- **CLI LLM-only mode implementation:** `mcp.type: 'none'` is interpreted at the config-resolution / `SmartServer` composition layer — `SmartServer` simply omits the MCP config argument to `SmartAgentBuilder`. `SmartAgentBuilderConfig` itself never sees `'none'`. Plan task confirms this chain remains intact after the `cli.ts` rewrite.
- **`LlmAdapter`:** audit whether it's used only for wrapping Agents, or also for other shims. Preserve non-Agent uses. If it only wraps Agents, delete along with the Agent hierarchy.
- **`smoke-adapters.ts`:** rewrite to exercise the new provider path. May become trivial or obsolete.
- **SAP AI Core package split:** if `sap-aicore-llm` and `sap-aicore-embedder` share common credentials/config utilities, decide whether to hoist those to a fourth package `sap-aicore-common` or duplicate into both. Lean: duplicate for simplicity; deduplicate in a future minor if repetition becomes painful.
- **Embedder factory registry location:** moves to server (see "Changes to existing packages → core" above). Each factory entry imports the concrete embedder class from its new package. Server's `resolveEmbedder()` continues to work with names like `ollama`, `openai`, `sap-ai-core` via the relocated registry.
- **Config-template defaults align with documented install steps:** the generated `smart-server.yaml` template defaults (e.g. `llm: deepseek`, `rag: ollama`) only work when the consumer installs the corresponding peer packages alongside `llm-agent-server`. The template's header comment, QUICK_START install snippet, Dockerfiles, and `MIGRATION-v11.md` install-modes section must all name the same peers. Plan task includes a dedicated consistency check across those four surfaces.

## Required end-to-end validation tasks

Given the scale of the refactor, drift between design and actual wiring is likely. The implementation plan MUST include these two explicit validation tasks at the end, each producing a concrete go/no-go signal before the release is tagged:

1. **Declarative-server boot test.** Install `@mcp-abap-adt/llm-agent-server` + the exact peers named in the generated `smart-server.yaml` template (e.g. `deepseek-llm`, `ollama-embedder`). The HTTP server boots successfully. Separately: install server WITHOUT one of those peers; starting the server with a config that references it must fail with `MissingProviderError` up front, not a cryptic runtime error mid-pipeline. Verifies: (a) peer-dep resolution contract, (b) `builtInEmbedderFactories` / LLM factory dynamic-import + error handling, (c) `SmartServer` composition.

2. **Minimal-install composition test.** A small consumer script installs `@mcp-abap-adt/llm-agent-server` + one LLM peer + one embedder peer (e.g. `deepseek-llm` + `ollama-embedder`) only. No SAP SDK, no Anthropic, no OpenAI-embedder on disk. The script constructs `SmartAgent` programmatically via `SmartAgentBuilder`, passes instances directly to fluent setters, runs one inference. Separately, the script attempts `resolveEmbedder('sap-ai-core')` and asserts that the factory registry throws `MissingProviderError` because the peer isn't installed. Verifies that: (a) optional peer deps actually stay optional at install time, (b) factory registry has clean missing-peer error handling, (c) programmatic composition works without declarative config.

3. **Core-only interface compatibility test.** A consumer script installs ONLY `@mcp-abap-adt/llm-agent`, writes a stub `ILlm` implementation, and uses `InMemoryRag` + `DirectEditStrategy` + `SimpleRagRegistry` from core. Never instantiates SmartAgent. Verifies core exports the full interface surface needed to write a bespoke agent without server.

## Future follow-ups (not in v11)

- `ollama-llm` if/when we add an Ollama LLM class (currently there isn't one).
- `@mcp-abap-adt/hana-vector-provider` — SAP HANA Cloud Vector Engine. Separate project; may live in a different repo given its SAP-specific dependencies.
- Formal "recipes" as meta-packages (e.g. `@mcp-abap-adt/deepseek-ollama-stack` that depends on the right packages). Low priority — consumers install directly.

## Review history (resolved)

Earlier review iterations surfaced these concerns. All are now addressed in the main sections above. Kept here as an audit trail:

- Server must depend on all provider/embedder packages so declarative YAML resolution works out of the box → **resolved** by the "Server package after v11.0.0" dependency list.
- `builtInEmbedderFactories` must move out of core → **resolved** by the "Changes to existing packages → core" bullet that relocates it to server.
- `mcp.type: 'none'` is handled at config-resolution / SmartServer composition, not inside `SmartAgentBuilderConfig` → **resolved** by the reworded `cli.ts` section and aligned implementation-plan bullet.
- Install recipes need to distinguish batteries-included server install from library-only minimal install → **resolved** by the two-mode install section in the migration guide.
- Library-only composition test originally mixed a no-server install with `SmartAgentBuilder`, which actually lives in `@mcp-abap-adt/llm-agent-server` → **resolved** by splitting into two validation tasks: (2) minimal-install (core + server + peers), and (3) true core-only (no server, consumer-written stub ILlm). Also prompted the server-deps rework: optional peer deps instead of unconditional transitive pulls.
- Post-peer-deps rework, "batteries-included" claims still lingered in install-mode descriptions and validation task wording → **resolved** by removing the "batteries-included" terminology entirely, stating the single contract (server + exactly the peers your config names), and relabeling validation task 1 as "declarative-server boot test".
- Library-only mode's SmartAgent usage without server install was logically impossible → **resolved** by splitting migration install modes into three: (a) server-managed declarative config, (b) programmatic server composition, (c) true core-only with no SmartAgent. Each clearly states required packages.
- Lower sections retained transitive-dependency wording after the peer-dependency rewrite → **resolved** by rewriting `Changes to existing packages → server` (embedder-factories move + optional peer dep declaration) and `Known items` (config-template defaults align with documented install steps) to match the optional-peer model.
- The top-level `Refactored in server → cli.ts` summary still referenced `mcp: { disabled: true }` → **resolved** by replacing it with the canonical `mcp.type: 'none'` wording consistent with later sections.
