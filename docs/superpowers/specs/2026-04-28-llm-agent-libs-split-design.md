# Design: complete the v12 package split with `@mcp-abap-adt/llm-agent-libs`

**Date:** 2026-04-28
**Issue:** #125
**Target version:** 12.0.1 (patch — completes the v12 split that landed incomplete in 12.0.0)

## Context

PR #124 was meant to land the v12 package split:

- `@mcp-abap-adt/llm-agent` — interfaces, public types, library helpers (no runtime composition).
- `@mcp-abap-adt/llm-agent-server` — runnable distribution (CLI + HTTP server).

What actually shipped in 12.0.0: only chat-bibliotheca-style helpers (api-adapters, `ClineClientAdapter`, `external-tools-normalizer`, `ToolCache`, `CircuitBreaker*`, `FallbackRag`, LLM call strategies, `tool-call-deltas`) moved to `llm-agent`. All composition classes (`SmartAgentBuilder`, `SessionManager`, `MCPClientWrapper`, `makeLlm`, `InMemoryMetrics`, `DefaultPipeline`, `HealthChecker`, plugin/skill managers, strategies, resilience wrappers, reranker, tracer, validator, history, config-watcher, factories) stayed in `llm-agent-server`. Consumers (e.g. `cloud-llm-hub`) cannot drop `llm-agent-server` — which was the entire point of the split.

## Goal

Complete the split so that consumers can build a SmartAgent without `@mcp-abap-adt/llm-agent-server` as a dependency. `llm-agent-server` becomes a runnable binary only — not importable as a library.

## Final package layout

```
@mcp-abap-adt/llm-agent          interfaces + public types + pure-library helpers
@mcp-abap-adt/llm-agent-libs     NEW: all runtime composition classes
@mcp-abap-adt/llm-agent-server   binary only: CLI + HTTP server (no library exports)
```

Dependency graph: `server → libs → llm-agent`. Provider packages (`openai-llm`, `anthropic-llm`, `deepseek-llm`, `sap-aicore-llm`, embedders, RAG stores) keep their current dependency on `llm-agent` and are consumed by `llm-agent-libs` from its factories.

## What moves where

### Into `@mcp-abap-adt/llm-agent` — interfaces and public types

All interfaces and public types currently colocated with implementations under `packages/llm-agent-server/src/smart-agent/**` move to `packages/llm-agent/src/interfaces/`. Implementations are stripped from these files; only `interface`/`type` declarations remain.

| From `llm-agent-server` | To `llm-agent` |
|---|---|
| `smart-agent/interfaces/{mcp-connection-strategy,model-resolver,pipeline}.ts` | `interfaces/` (move as-is) |
| `smart-agent/metrics/types.ts` (`IMetrics`, `ICounter`, `IHistogram`, `MetricsSnapshot`, `CounterSnapshot`, `HistogramSnapshot`) | `interfaces/metrics.ts` |
| `smart-agent/validator/types.ts` (`IOutputValidator`, `ValidationResult`) | `interfaces/validator.ts` |
| `smart-agent/tracer/types.ts` (`ITracer`, `ISpan`, `SpanOptions`, `SpanStatus`) | `interfaces/tracer.ts` |
| `smart-agent/session/types.ts` (`ISessionManager`) | `interfaces/session.ts` |
| `smart-agent/reranker/types.ts` (`IReranker`) | `interfaces/reranker.ts` |
| `smart-agent/health/types.ts` (`HealthStatus`, `HealthComponentStatus`, `CircuitBreakerStatus`) | `interfaces/health.ts` |
| `smart-agent/plugins/index.ts` types (`IPluginLoader`, `LoadedPlugins`, `PluginExports`, `FileSystemPluginLoaderConfig`) | `interfaces/plugin.ts` (extend) |
| `smart-agent/builder.ts` types (`SmartAgentBuilderConfig`, `SmartAgentHandle`, `BuilderMcpConfig`, `BuilderPromptsConfig`) | `interfaces/builder.ts` (new) |
| `smart-agent/agent.ts` types (`SmartAgentRagStores`, `SmartAgentReconfigureOptions`) | `interfaces/agent-contracts.ts` (extend) |
| `smart-agent/adapters/llm-adapter.ts` types (`BaseAgentLlmBridge`, `AgentCallOptions`, `LlmAdapterProviderInfo`) | `interfaces/agent-contracts.ts` (extend) |
| `smart-agent/providers.ts` types (`LlmProviderConfig`, `RagResolutionConfig/Options`, `EmbedderResolutionConfig/Options`) | `interfaces/providers.ts` (new) |
| `smart-agent/embedder-factories.ts` type `EmbedderFactoryOpts` | `interfaces/providers.ts` |
| `smart-agent/config/config-watcher.ts` types (`ConfigWatcherOptions`, `HotReloadableConfig`) | `interfaces/config.ts` (new) |
| `smart-agent/resilience/{retry-llm,token-bucket-rate-limiter}.ts` types (`RetryOptions`, `TokenBucketConfig`) | `interfaces/resilience.ts` (new) |
| `smart-agent/utils/lazy.ts` type `LazyOptions` | `interfaces/lazy.ts` (new); class `LazyInitError` and `lazy()` stay in libs |
| `smart-agent/pipeline/index.ts` types (`StageDefinition`, `IStageHandler`, `PipelineContext`, `BuiltInStageType`, `ControlFlowType`, `StageType`) | `interfaces/pipeline.ts` (extend) |
| `smart-agent/logger/` types | `interfaces/request-logger.ts` (extend if missing) |

`llm-agent/src/index.ts` re-exports all the new interface modules through `interfaces/index.ts`. No runtime classes are added here.

### Into new `@mcp-abap-adt/llm-agent-libs` — implementations

Port-by-port from `packages/llm-agent-server/src/`:

```
mcp/client.ts                          → src/mcp/client.ts             (MCPClientWrapper)
smart-agent/agent.ts                   → src/smart-agent/agent.ts
smart-agent/builder.ts                 → src/smart-agent/builder.ts
smart-agent/providers.ts               → src/smart-agent/providers.ts
smart-agent/adapters/                  → src/smart-agent/adapters/
smart-agent/classifier/                → src/smart-agent/classifier/
smart-agent/config/                    → src/smart-agent/config/
smart-agent/context/                   → src/smart-agent/context/
smart-agent/embedder-factories.ts      → src/smart-agent/embedder-factories.ts
smart-agent/health/                    → src/smart-agent/health/        (HealthChecker)
smart-agent/history/                   → src/smart-agent/history/
smart-agent/logger/                    → src/smart-agent/logger/        (Default/Noop request loggers)
smart-agent/mcp-client-factory.ts      → src/smart-agent/mcp-client-factory.ts
smart-agent/metrics/                   → src/smart-agent/metrics/       (InMemory/Noop)
smart-agent/otel/                      → src/smart-agent/otel/
smart-agent/pipeline/                  → src/smart-agent/pipeline/
smart-agent/plugins/                   → src/smart-agent/plugins/       (FileSystemPluginLoader, etc.)
smart-agent/policy/                    → src/smart-agent/policy/
smart-agent/rag-factories.ts           → src/smart-agent/rag-factories.ts
smart-agent/reranker/                  → src/smart-agent/reranker/      (LlmReranker, NoopReranker)
smart-agent/resilience/                → src/smart-agent/resilience/    (RetryLlm, RateLimiterLlm, TokenBucketRateLimiter)
smart-agent/session/                   → src/smart-agent/session/       (SessionManager, NoopSessionManager)
smart-agent/skills/                    → src/smart-agent/skills/        (Claude/Codex/FileSystem managers)
smart-agent/strategies/                → src/smart-agent/strategies/    (Lazy/Periodic/Noop connection)
smart-agent/testing/                   → src/smart-agent/testing/
smart-agent/tracer/                    → src/smart-agent/tracer/        (NoopTracer)
smart-agent/utils/                     → src/smart-agent/utils/         (lazy, LazyInitError)
smart-agent/validator/                 → src/smart-agent/validator/     (NoopValidator)
```

`llm-agent-libs/src/index.ts` re-exports the same set of runtime symbols that the current `llm-agent-server/src/index.ts` exports — minus interfaces/types (which now live in `llm-agent` and are re-exported by consumers from there).

`llm-agent-libs/package.json` `dependencies`:

- `@mcp-abap-adt/llm-agent` (workspace)
- `@mcp-abap-adt/openai-llm`, `anthropic-llm`, `deepseek-llm`, `sap-aicore-llm` (used by `providers.ts`)
- `@mcp-abap-adt/openai-embedder`, `ollama-embedder`, `sap-aicore-embedder` (used by `embedder-factories.ts`)
- `@mcp-abap-adt/qdrant-rag`, `hana-vector-rag`, `pg-vector-rag` (used by `rag-factories.ts`)
- Plus runtime deps already in server (`@modelcontextprotocol/sdk`, OpenTelemetry, etc.) — copy verbatim from current `llm-agent-server/package.json`.

### Stays in `@mcp-abap-adt/llm-agent-server` — binary only

```
src/agent.ts                           legacy Agent class (binary helper)
src/smart-agent/cli.ts
src/smart-agent/server.ts
src/smart-agent/smart-server.ts
src/smart-agent/check-models-cli.ts
src/smoke-adapters.ts
src/generated/                         (codegen artifacts)
```

`llm-agent-server/package.json`:

- `"bin"` keeps current binary entries.
- `"main"` / `"types"` / `"exports"` removed (or set to a stub `index.ts` with `export {}` — see Risks). Package is no longer importable as a library.
- `dependencies`: drops everything that moved; adds `@mcp-abap-adt/llm-agent-libs` (workspace) and `@mcp-abap-adt/llm-agent`.

## Public API surface

### `@mcp-abap-adt/llm-agent` — new exports added on top of 12.0.0

All interfaces from the table above, re-exported through `interfaces/index.ts` and surfaced from `src/index.ts`. The library helpers already exported in 12.0.0 stay unchanged.

### `@mcp-abap-adt/llm-agent-libs` — new package

Runtime classes mirroring the current `llm-agent-server@12.0.0` exports list (full enumeration is in the v12.0.0 server `index.ts`). Interfaces/types are NOT re-exported from libs — consumers import them from `@mcp-abap-adt/llm-agent`.

### `@mcp-abap-adt/llm-agent-server` — no library exports

Package publishes only `bin/`. Importing from it as a library will fail (no `main`/`exports` field).

## Versioning and release

- All in-monorepo packages bump to **12.0.1** via a `patch` changeset. Rationale: the v12 split was incomplete; 12.0.1 finishes it. No public API is removed — only relocated.
- New package `@mcp-abap-adt/llm-agent-libs` is published at 12.0.1 directly to align with the family.
- Release notes call out: symbols that briefly appeared only in `llm-agent-server@12.0.0` are now imported from `llm-agent` (interfaces) or `llm-agent-libs` (classes). This is framed as a fix to issue #125, not a breaking change.

## Migration for consumers (cloud-llm-hub style)

```ts
// Before (12.0.0)
import { SmartAgentBuilder, SessionManager, type IMetrics } from '@mcp-abap-adt/llm-agent-server';

// After (12.0.1)
import { SmartAgentBuilder, SessionManager } from '@mcp-abap-adt/llm-agent-libs';
import type { IMetrics } from '@mcp-abap-adt/llm-agent';
```

Documented in `packages/llm-agent/README.md` and `packages/llm-agent-libs/README.md` migration sections.

## Execution order

1. Scaffold `packages/llm-agent-libs/` — `package.json`, `tsconfig.json`, biome inheritance, empty `src/index.ts`. Add to root workspaces and changeset config.
2. Move interfaces/types from `llm-agent-server` → `llm-agent/src/interfaces/`. Update `llm-agent/src/index.ts`. Run `tsc --noEmit` across the workspace and fix any cycles surfaced.
3. Move implementations from `llm-agent-server/src/{smart-agent,mcp}/**` → `llm-agent-libs/src/`. Rewrite their imports of interfaces to `@mcp-abap-adt/llm-agent`. Populate `llm-agent-libs/src/index.ts` with the same runtime export list as current `llm-agent-server` 12.0.0 (minus interfaces).
4. Trim `llm-agent-server/src/`: keep only binary entry points; rewrite their imports to use `@mcp-abap-adt/llm-agent-libs` and `@mcp-abap-adt/llm-agent`. Strip library exports from `package.json` (`main`, `types`, `exports`). Update `dependencies`.
5. Update root `tsconfig.json` references and any path mappings.
6. `npm install`, `npm run build`, `npm run lint`. Smoke-test the binary: `npm run dev` (MCP) and `npm run dev:llm` (LLM-only) from `packages/llm-agent-server`.
7. Add changeset (`patch` for all touched packages, including the new libs at 12.0.1).
8. Update `docs/ARCHITECTURE.md` and per-package READMEs with the new layout and migration table.
9. Open PR closing #125.

## Risks and mitigations

- **Circular imports.** A class in `libs` referencing a type that still lives in server, or vice versa. Mitigation: step 2 lands first and `tsc --noEmit` must be clean before step 3 begins.
- **Provider / RAG package version drift.** `libs` must use the same versions of `openai-llm`/`anthropic-llm`/etc. as 12.0.0 server. Copy `dependencies` block verbatim before tweaking.
- **`llm-agent-server` no longer exports a library.** Any consumer still importing from it will get a resolution error after upgrading to 12.0.1. This is the intended end-state and is documented in release notes; per the v12 contract, no consumer should have been importing from server in the first place.
- **`package.json` `exports` removal vs. tooling.** Some bundlers warn when a package has neither `main` nor `exports`. Acceptable since the package is binary-only; if it causes friction, set `"exports": { "./package.json": "./package.json" }` to keep package metadata resolvable.
- **Test suite (none).** There are no unit tests; the smoke test is `npm run build` + binary launch. Verification relies on type checking + manual smoke run; this is unchanged from current practice.
- **Lockfile churn.** Per repo convention, `package-lock.json` changes are committed alongside the refactor.

## Out of scope

- Adding unit tests.
- Restructuring interfaces beyond what is needed to relocate them.
- Changing any provider package (`openai-llm`, etc.) beyond a 12.0.1 version bump if their lockfiles shift.
- Splitting `llm-agent-libs` into multiple entrypoints. Single `index.ts` for now.
