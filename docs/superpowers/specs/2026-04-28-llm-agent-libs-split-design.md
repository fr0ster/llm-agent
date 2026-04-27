# Design: complete the v12 package split into cohesive packages

**Date:** 2026-04-28
**Issue:** #125
**Target version:** 12.0.1 (patch — completes the v12 split that landed incomplete in 12.0.0)

## Context

PR #124 was meant to land the v12 package split:

- `@mcp-abap-adt/llm-agent` — interfaces, public types, library helpers (no runtime composition).
- `@mcp-abap-adt/llm-agent-server` — runnable distribution (CLI + HTTP server).

What actually shipped in 12.0.0: only chat-style helpers (api-adapters, `ClineClientAdapter`, `external-tools-normalizer`, `ToolCache`, `CircuitBreaker*`, `FallbackRag`, LLM call strategies, `tool-call-deltas`) moved to `llm-agent`. All composition classes (`SmartAgentBuilder`, `SessionManager`, `MCPClientWrapper`, `makeLlm`/`makeRag`, `InMemoryMetrics`, `DefaultPipeline`, `HealthChecker`, plugin/skill managers, strategies, resilience wrappers, reranker, tracer, validator, history, config-watcher, factories) stayed in `llm-agent-server`. Consumers (e.g. `cloud-llm-hub`) cannot drop `llm-agent-server` — which was the entire point of the split.

## Goal

Complete the split so consumers can build a SmartAgent without `@mcp-abap-adt/llm-agent-server` as a dependency. `llm-agent-server` becomes a runnable binary only. Composition is delivered via cohesive packages organised by domain (MCP, RAG, core composition), with `llm-agent-libs` as the SmartAgent composition entry point and `llm-agent-mcp` / `llm-agent-rag` available for narrower standalone use.

Also in scope: convert `makeLlm()` / `makeDefaultLlm()` / `makeRag()` from static provider imports to dynamic optional imports. The current `package.json` already declares the LLM/RAG provider packages as `optional peerDependencies`, but `providers.ts` and `rag-factories.ts` import them statically — the optional-peer promise is currently a lie. This refactor delivers what v12 advertised.

All three factories become async (`Promise<ILlm>` / `Promise<IRag>`). Direct callers add one `await` per call. `SmartAgentBuilder.build()` is already async, so the main builder API does not change.

Architectural rationale for full async (rather than keeping factories sync via prefetch indirection): we are accepting a breaking change anyway, and the cleanest result is symmetric — both LLM and RAG factories use the same dynamic-import + `MissingProviderError` pattern, no implicit consumer-side prefetch contract. One pattern is easier to reason about than two. The `prefetchEmbedderFactories()` / `prefetchRagFactories()` helpers may stay as optional warm-up utilities but are no longer prerequisites for `makeRag()`.

## Final package layout

```
@mcp-abap-adt/llm-agent          contracts: interfaces, public types, lightweight helpers
@mcp-abap-adt/llm-agent-mcp      MCP client wrapper + adapter + connection strategies
@mcp-abap-adt/llm-agent-rag      RAG/embedder composition (makeRag, resolveEmbedder, factories)
@mcp-abap-adt/llm-agent-libs     core composition: builder, agent, pipeline, sessions, ...
@mcp-abap-adt/llm-agent-server   binary only (CLI + HTTP server, no library exports)
```

Dependency graph:

```
                              llm-agent (contracts + lightweight helpers)
                              ▲     ▲     ▲
                              │     │     │
                  ┌───────────┘     │     └───────────┐
                  │                 │                 │
        llm-agent-mcp     llm-agent-rag    (provider/embedder/rag leaf packages)
                  ▲                 ▲                 ▲ (optional peer)
                  │                 │                 │
                  └────── llm-agent-libs (composition root) ──┘
                                    ▲
                                    │
                          llm-agent-server (binary)
```

`llm-agent-libs` directly depends on `llm-agent`, `llm-agent-mcp`, and `llm-agent-rag`. LLM provider leaves remain optional peers of `llm-agent-libs`; embedder/RAG backend leaves remain optional peers of `llm-agent-rag`. Consumers install only the backends they use.

Consumer rule for SmartAgent composition: depend on `llm-agent-libs`; it pulls `llm-agent`, `llm-agent-mcp`, and `llm-agent-rag` transitively. Standalone use of `llm-agent-mcp` or `llm-agent-rag` is supported when a consumer needs only MCP or only RAG/embedder composition. Do not mix internal package versions manually — use matching published versions.

## Versioning policy

Current state of `.changeset/config.json` (verified 2026-04-28): the `fixed` group contains all 12 workspace packages — `llm-agent`, `llm-agent-server`, plus all 10 provider/embedder/RAG leaves. That is why the v12.0.0 release bumped every package together.

Narrow the existing `fixed` group to only the five SmartAgent family packages:

```jsonc
// .changeset/config.json (excerpt)
"fixed": [["@mcp-abap-adt/llm-agent", "@mcp-abap-adt/llm-agent-mcp",
           "@mcp-abap-adt/llm-agent-rag", "@mcp-abap-adt/llm-agent-libs",
           "@mcp-abap-adt/llm-agent-server"]]
```

All five always ship at the same version. A patch in `llm-agent-mcp` bumps every package to the next patch, etc. This guarantees that `llm-agent-libs@X` always pairs with `llm-agent-mcp@X` and `llm-agent-rag@X` — drift inside the family cannot occur.

**Delta vs. current behaviour**: provider/embedder/RAG leaf packages (`openai-llm`, embedders, vector stores, etc.) leave the fixed group. From 12.0.1 onward they evolve at their own cadence and only need to satisfy the optional peer ranges declared by `llm-agent-libs` / `llm-agent-rag`. Their next release after this refactor will not auto-bump together with the family unless an explicit changeset entry is added for them.

**Standalone consumers**: a project that depends only on `@mcp-abap-adt/llm-agent-mcp` (or only `@mcp-abap-adt/llm-agent-rag`) will see version bumps even when that package's own code did not change — because of the family fixed group. Treat the family version as the meaningful semver. Internal package versions are kept in lockstep, so a bump alone is not a signal of a behavioural change in that specific package; consult the changeset entry to see what actually moved.

## What moves where

### `@mcp-abap-adt/llm-agent` — contracts (additive)

Existing 12.0.0 surface is preserved. New additions are interfaces and public types currently colocated with implementations in `packages/llm-agent-server/src/smart-agent/**`. Implementation files are stripped to type-only declarations.

Decision rule: a type goes to `llm-agent` if any of the following holds:

- It is an extension contract (`I*` interface) that consumers may implement.
- It is a public DTO surfaced by an HTTP / observability boundary (e.g. `HealthStatus`, `MetricsSnapshot`).
- It is a parameter or return value of a public composition API that consumers type against.

Implementation-owned configuration types of a single concrete class (e.g. `RetryOptions`, `FileSystemPluginLoaderConfig`, `ConfigWatcherOptions`) live in the same package as the class itself.

Before moving any type, grep `packages/llm-agent/src/interfaces/` and `packages/llm-agent/src/types.ts` — if a type with the same (or near-identical) name already exists, integrate or deduplicate rather than create a duplicate. Known cases at the time of writing:

- `AgentCallOptions` already exists in `packages/llm-agent/src/interfaces/agent-contracts.ts`. The `AgentCallOptions` in `llm-agent-server/src/smart-agent/adapters/llm-adapter.ts` must be reconciled with it (most likely deduplicated against the existing one) rather than copied.
- `LLMProviderConfig` (uppercase LLM) already exists in `packages/llm-agent/src/types.ts` and is the consumer-facing provider config. The `LlmProviderConfig` (lowercase) used internally by `makeLlm` in `smart-agent/providers.ts` is a **different** type with a similar name; it stays in `llm-agent-libs`. Do not merge them — but consider renaming the libs-internal one (e.g. to `MakeLlmConfig`) to remove the naming collision once the move is done.
- `MissingProviderError` is already in `@mcp-abap-adt/llm-agent` and imported by both `rag-factories.ts` and `embedder-factories.ts`. Both `llm-agent-rag` and `llm-agent-libs` will continue to import it from `llm-agent` — no action needed.

| From `llm-agent-server` | To `llm-agent` |
|---|---|
| `smart-agent/interfaces/{mcp-connection-strategy,model-resolver,pipeline}.ts` | `interfaces/` (move as-is) |
| `smart-agent/metrics/types.ts` (`IMetrics`, `ICounter`, `IHistogram`, `MetricsSnapshot`, `CounterSnapshot`, `HistogramSnapshot`) | `interfaces/metrics.ts` |
| `smart-agent/validator/types.ts` (`IOutputValidator`, `ValidationResult`) | `interfaces/validator.ts` |
| `smart-agent/tracer/types.ts` (`ITracer`, `ISpan`, `SpanOptions`, `SpanStatus`) | `interfaces/tracer.ts` |
| `smart-agent/session/types.ts` (`ISessionManager`) | `interfaces/session.ts` |
| `smart-agent/reranker/types.ts` (`IReranker`) | `interfaces/reranker.ts` |
| `smart-agent/health/types.ts` (`HealthStatus`, `HealthComponentStatus`, `CircuitBreakerStatus`) | `interfaces/health.ts` |
| `smart-agent/plugins/index.ts` types `IPluginLoader`, `LoadedPlugins`, `PluginExports` | `interfaces/plugin.ts` (extend) |
| `smart-agent/builder.ts` type `SmartAgentHandle` | `interfaces/builder.ts` (new) |
| `smart-agent/adapters/llm-adapter.ts` type `BaseAgentLlmBridge` | `interfaces/agent-contracts.ts` (extend) |
| `smart-agent/pipeline/index.ts` types `StageDefinition`, `IStageHandler`, `PipelineContext`, `BuiltInStageType`, `ControlFlowType`, `StageType` | `interfaces/pipeline.ts` (extend) |
| `smart-agent/logger/` `ILogger`/`LogEvent` types (if not already exported) | `interfaces/request-logger.ts` (extend) |

Types that stay with their implementation (move to the package below that owns the class):

`FileSystemPluginLoaderConfig`, `ConfigWatcherOptions`, `HotReloadableConfig`, `RetryOptions`, `TokenBucketConfig`, `LlmProviderConfig`, `EmbedderFactoryOpts`, `RagResolutionConfig/Options`, `EmbedderResolutionConfig/Options`, `SmartAgentBuilderConfig`, `BuilderMcpConfig`, `BuilderPromptsConfig`, `SmartAgentRagStores`, `SmartAgentReconfigureOptions`, `AgentCallOptions`, `LlmAdapterProviderInfo`, `LazyOptions`.

`llm-agent/src/index.ts` re-exports the new interface modules through `interfaces/index.ts`. No runtime composition classes are added here.

### `@mcp-abap-adt/llm-agent-mcp` — MCP composition

Owns everything needed to create and operate an MCP client without bringing the full SmartAgent.

```
src/client.ts               ← from llm-agent-server/src/mcp/client.ts                   (MCPClientWrapper, MCPClientConfig, TransportType)
src/adapter.ts              ← from llm-agent-server/src/smart-agent/adapters/mcp-client-adapter.ts  (McpClientAdapter)
src/factory.ts              ← from llm-agent-server/src/smart-agent/mcp-client-factory.ts          (createDefaultMcpClient)
src/strategies/             ← from llm-agent-server/src/smart-agent/strategies/                    (Lazy/Periodic/Noop connection strategies)
src/index.ts                public exports
```

`package.json` deps:
- `@mcp-abap-adt/llm-agent` (workspace)
- `@modelcontextprotocol/sdk` (runtime dep — MCP SDK is required)

No optional peers (transports are configured via the SDK directly).

### `@mcp-abap-adt/llm-agent-rag` — RAG/embedder composition

Owns the composition layer above the leaf RAG / embedder packages.

```
src/embedder-factories.ts   ← from llm-agent-server/src/smart-agent/embedder-factories.ts  (resolveEmbedder, builtInEmbedderFactories, prefetchEmbedderFactories, EmbedderFactoryOpts)
src/rag-factories.ts        ← from llm-agent-server/src/smart-agent/rag-factories.ts plus the RAG/embedder resolution block from providers.ts (makeRag, resolveRag, resolution config types)
src/index.ts                public exports
```

`package.json`:
- `dependencies`: `@mcp-abap-adt/llm-agent`
- `peerDependencies` (all `optional` via `peerDependenciesMeta`): `@mcp-abap-adt/openai-embedder`, `ollama-embedder`, `sap-aicore-embedder`, `qdrant-rag`, `hana-vector-rag`, `pg-vector-rag`
- `devDependencies` mirroring those peers so the package builds inside the monorepo

Rationale: factories use dynamic `import()` + `MissingProviderError`, so consumers only install the embedder/RAG backends they actually need.

Implementation note (in-scope conversion): current `makeRag()` statically imports `OllamaRag` from `@mcp-abap-adt/ollama-embedder` for the default path, plus other RAG backends are wired in similarly. During the move, convert `makeRag()` to dynamic `import()` + `MissingProviderError` for every backend, including the Ollama default. The function becomes async: `makeRag(cfg, ...): Promise<IRag>`. Importing `llm-agent-rag` must not require any specific embedder/RAG package — only the ones the consumer configures.

Do not substitute `OllamaRag` with a `resolveEmbedder('ollama') + VectorRag` composition unless `OllamaRag` is verified to be exactly that combination at the source level — preserve current behaviour by dynamic-importing `OllamaRag` itself.

### `@mcp-abap-adt/llm-agent-libs` — core composition

Everything else — the runtime that orchestrates LLM, MCP, and RAG into a SmartAgent.

```
src/builder.ts              ← from llm-agent-server/src/smart-agent/builder.ts            (SmartAgentBuilder + Config types)
src/agent.ts                ← from llm-agent-server/src/smart-agent/agent.ts              (SmartAgent runtime)
src/providers.ts            ← from llm-agent-server/src/smart-agent/providers.ts          (makeLlm, DefaultModelResolver — RAG factories are stripped out and now live in llm-agent-rag)
src/adapters/               ← from llm-agent-server/src/smart-agent/adapters/             (LlmAdapter, LlmProviderBridge; mcp-client-adapter is gone — moved to llm-agent-mcp)
src/classifier/             ← from llm-agent-server/src/smart-agent/classifier/
src/config/                 ← from llm-agent-server/src/smart-agent/config/               (ConfigWatcher + Options types)
src/context/                ← from llm-agent-server/src/smart-agent/context/
src/health/                 ← from llm-agent-server/src/smart-agent/health/               (HealthChecker)
src/history/                ← from llm-agent-server/src/smart-agent/history/              (HistoryMemory, HistorySummarizer)
src/logger/                 ← from llm-agent-server/src/smart-agent/logger/               (DefaultRequestLogger, NoopRequestLogger)
src/metrics/                ← from llm-agent-server/src/smart-agent/metrics/              (InMemoryMetrics, NoopMetrics)
src/otel/                   ← from llm-agent-server/src/smart-agent/otel/                 (OTel adapter — exposed via `./otel` subpath)
src/pipeline/               ← from llm-agent-server/src/smart-agent/pipeline/             (DefaultPipeline, PipelineExecutor, handler registry)
src/plugins/                ← from llm-agent-server/src/smart-agent/plugins/              (FileSystemPluginLoader)
src/policy/                 ← from llm-agent-server/src/smart-agent/policy/
src/reranker/               ← from llm-agent-server/src/smart-agent/reranker/             (LlmReranker, NoopReranker)
src/resilience/             ← from llm-agent-server/src/smart-agent/resilience/           (RetryLlm, RateLimiterLlm, TokenBucketRateLimiter)
src/session/                ← from llm-agent-server/src/smart-agent/session/              (SessionManager, NoopSessionManager)
src/skills/                 ← from llm-agent-server/src/smart-agent/skills/               (Claude/Codex/FileSystem skill managers)
src/testing/                ← from llm-agent-server/src/smart-agent/testing/              (exposed via `./testing` subpath)
src/tracer/                 ← from llm-agent-server/src/smart-agent/tracer/               (NoopTracer)
src/utils/                  ← from llm-agent-server/src/smart-agent/utils/                (lazy, LazyInitError, LazyOptions)
src/validator/              ← from llm-agent-server/src/smart-agent/validator/            (NoopValidator)
src/index.ts                public exports
```

`package.json`:
- `dependencies`: `@mcp-abap-adt/llm-agent`, `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`, plus the runtime libs that are directly imported (`yaml`, `dotenv` if used at runtime, `zod`, OTel API surface used by adapters).
- `peerDependencies` (all `optional`): `@mcp-abap-adt/openai-llm`, `anthropic-llm`, `deepseek-llm`, `sap-aicore-llm`. These are LLM provider backends used by `makeLlm()` via dynamic `import()`.
- `devDependencies` mirroring the LLM peer packages.

Implementation note (in-scope conversion): current `providers.ts` imports each LLM provider statically (`OpenAIProvider`, `AnthropicProvider`, `DeepSeekProvider`, `SapAiCoreProvider`). During the move, convert `makeLlm()` and `makeDefaultLlm()` to dynamic `import()` plus `MissingProviderError`. Both functions become async: `makeLlm(cfg, temperature): Promise<ILlm>` and `makeDefaultLlm(...): Promise<ILlm>`.

Affected callsites:

- `SmartAgentBuilder.build()` is already `async` (currently `async build(): Promise<SmartAgentHandle>`); the internal `makeLlm(...)` call gains an `await`. No external signature change.
- `testing/index.ts` exports its own `makeLlm` / `makeRag` helpers — those are test stubs and stay synchronous (they do not load real providers).
- External direct callsites: `cloud-llm-hub/tools/generate-tool-intents.ts:17` is the only known external `makeLlm` user. Migration adds one `await`. Direct `makeDefaultLlm()` and `makeRag()` callers, if any are found during implementation, need the same treatment.

`makeRag()` in the new `llm-agent-rag` package undergoes the parallel conversion — see the `llm-agent-rag` section above for details.

Subpath exports:
- `@mcp-abap-adt/llm-agent-libs` — main composition surface.
- `@mcp-abap-adt/llm-agent-libs/testing` — test helpers (replaces current `@mcp-abap-adt/llm-agent-server/testing`).
- `@mcp-abap-adt/llm-agent-libs/otel` — OTel tracer adapter (replaces current `@mcp-abap-adt/llm-agent-server/otel`).

### `@mcp-abap-adt/llm-agent-server` — binary only

```
src/agent.ts                            legacy Agent class (binary helper)
src/smart-agent/cli.ts                  CLI entry
src/smart-agent/server.ts               HTTP server
src/smart-agent/smart-server.ts         server harness
src/smart-agent/check-models-cli.ts     diagnostic CLI
src/smoke-adapters.ts
src/generated/                          codegen artifacts
```

`package.json`:
- `bin` keeps current binary entries.
- `main` / `types` / `exports` removed (or `exports` set to `{ "./package.json": "./package.json" }` only). The package is no longer importable as a library — that is the intended contract.
- `dependencies`: drops everything that moved; adds `@mcp-abap-adt/llm-agent`, `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`, `@mcp-abap-adt/llm-agent-libs`. List all four explicitly even though `llm-agent-libs` already pulls the others transitively — any binary entry point that imports directly from `llm-agent-mcp` or `llm-agent-rag` (e.g. `check-models-cli.ts`) needs them as direct deps to satisfy strict bundler / `noUncheckedSideEffects` checks.

The legacy top-level `Agent` class stays server-internal. Public composition path is `SmartAgentBuilder` from `@mcp-abap-adt/llm-agent-libs`.

## Public API surface

### `@mcp-abap-adt/llm-agent`

12.0.0 surface preserved. Adds the interface modules listed in the table above through `interfaces/index.ts`. No runtime composition classes.

### `@mcp-abap-adt/llm-agent-mcp`

Exports `MCPClientWrapper`, `MCPClientConfig`, `TransportType`, `McpClientAdapter`, `createDefaultMcpClient`, `LazyConnectionStrategy`, `PeriodicConnectionStrategy`, `NoopConnectionStrategy`.

### `@mcp-abap-adt/llm-agent-rag`

Exports `makeRag`, `resolveEmbedder`, `builtInEmbedderFactories`, `prefetchEmbedderFactories`, `EmbedderFactoryOpts`, `RagResolutionConfig`, `RagResolutionOptions`, `EmbedderResolutionConfig`, `EmbedderResolutionOptions`.

### `@mcp-abap-adt/llm-agent-libs`

Re-exports the runtime composition surface that is currently in `llm-agent-server@12.0.0` minus what was reassigned to `llm-agent-mcp` and `llm-agent-rag`, plus impl-owned config types (`SmartAgentBuilderConfig`, `RetryOptions`, `TokenBucketConfig`, `ConfigWatcherOptions`, `HotReloadableConfig`, `FileSystemPluginLoaderConfig`, `SmartAgentRagStores`, `SmartAgentReconfigureOptions`, `AgentCallOptions`, `LlmAdapterProviderInfo`, `LazyOptions`).

May re-export interfaces from `@mcp-abap-adt/llm-agent` as type-only convenience exports where it improves consumer ergonomics. Canonical definitions stay in `llm-agent`.

### `@mcp-abap-adt/llm-agent-server`

No library exports. `bin` only.

## Versioning and release

- All five SmartAgent family packages bump to **12.0.1** via a single `patch` changeset.
- Configure changesets `fixed` group covering the five packages so future releases stay aligned.
- The new packages `llm-agent-mcp`, `llm-agent-rag`, `llm-agent-libs` are published at 12.0.1 directly.
- Release notes frame this as completing the v12 split and fixing issue #125. No high-level `SmartAgentBuilder` API is removed; direct `makeLlm()` / `makeDefaultLlm()` / `makeRag()` factory callers must add `await` as part of the migration.

## Migration for consumers (cloud-llm-hub style)

```ts
// Before (12.0.0)
import {
  SmartAgentBuilder,
  SessionManager,
  MCPClientWrapper,
  McpClientAdapter,
  makeLlm,
  InMemoryMetrics,
  type SmartAgentHandle,
} from '@mcp-abap-adt/llm-agent-server';

// After (12.0.1)
import { type SmartAgentHandle } from '@mcp-abap-adt/llm-agent';
import { MCPClientWrapper, McpClientAdapter } from '@mcp-abap-adt/llm-agent-mcp';
import {
  SmartAgentBuilder,
  SessionManager,
  makeLlm,
  InMemoryMetrics,
} from '@mcp-abap-adt/llm-agent-libs';

// makeLlm and makeRag are now async — add await at direct callsites
const llm = await makeLlm(cfg, temperature);
const rag = await makeRag(ragCfg, { embedder, breaker });
```

Consumers calling `makeRag()` directly must add `await`. Consumers using only `SmartAgentBuilder` are unaffected (`build()` is already async and absorbs the change internally).

Most cloud-llm-hub imports already come from `@mcp-abap-adt/llm-agent` (they import `Message`, `IRag`, `VectorRag`, etc. from there) — those lines do not change. Only the `@mcp-abap-adt/llm-agent-server` imports get rewritten to one of `llm-agent-mcp`, `llm-agent-rag`, or `llm-agent-libs` depending on the symbol. README of each new package contains the migration table.

## Future split criteria

Recording when a leaf currently inside `llm-agent-libs` should be promoted to its own package:

- **Real consumer demand**: at least one external consumer needs the leaf without `SmartAgentBuilder`.
- **Independent lifecycle**: the leaf changes substantially more often (or rarely) than the rest of `llm-agent-libs`, creating noisy version bumps.
- **Heavy optional dependency**: the leaf pulls a runtime dep (e.g. native module) that consumers without that feature should not have to install.

If none of these triggers, the leaf stays in `llm-agent-libs`. The fixed-version policy makes promotion cheap (no peer-range coordination), so we can defer until a trigger fires.

## Execution order

1. Narrow the existing changesets `fixed` group so it covers only the five SmartAgent family packages. Verify with `changeset status` (do not run `changeset version` until step 12 — it mutates `package.json` files).
2. Scaffold three new packages (`llm-agent-mcp`, `llm-agent-rag`, `llm-agent-libs`) with `package.json`, `tsconfig.json`, biome inheritance, empty `src/index.ts`. Add to root `workspaces`.
3. Move type-only declarations from `llm-agent-server` → `llm-agent/src/interfaces/` per the table above. Update `llm-agent/src/index.ts`. Run `tsc --noEmit` across the workspace; resolve any cycles before continuing.
4. Move MCP code (`mcp/client.ts`, `smart-agent/adapters/mcp-client-adapter.ts`, `smart-agent/mcp-client-factory.ts`, `smart-agent/strategies/`) into `llm-agent-mcp`. Update imports to `@mcp-abap-adt/llm-agent`. Populate `llm-agent-mcp/src/index.ts`.
5. Move RAG/embedder code (`smart-agent/embedder-factories.ts`, `smart-agent/rag-factories.ts`, and the RAG/embedder resolution block from `smart-agent/providers.ts`) into `llm-agent-rag`. Leave only the LLM-related portion (`makeLlm`, `DefaultModelResolver`) for step 6. Convert `makeRag()` from static imports (including the default `OllamaRag` path) to dynamic optional imports — the function becomes async. Configure optional peers + devDeps. Populate `llm-agent-rag/src/index.ts`.
6. Move everything else listed under `llm-agent-libs` into that package. Rewrite cross-package imports to use `@mcp-abap-adt/llm-agent`, `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`. Convert `makeLlm()` / `makeDefaultLlm()` provider loading from static imports to dynamic optional imports (the `makeRag()` conversion is part of step 5). Configure optional LLM peers + devDeps. Populate `llm-agent-libs/src/index.ts`.
7. Add `package.json` `exports` entries: `"."`, `"./testing"`, `"./otel"` for `llm-agent-libs`.
8. Move implementation tests with the code into the new packages; only CLI / HTTP tests remain in `llm-agent-server`. Before moving, audit each test file for relative cross-package imports (e.g. `import ... from '../../testing/...'`) and rewrite them to use `@mcp-abap-adt/...` package paths so the move does not break resolution.
9. Trim `llm-agent-server/src/`: keep CLI / HTTP server / legacy Agent only. Rewrite imports. Drop library exports from `package.json`. Update `dependencies`.
10. Update root `tsconfig.json` references and any path mappings.
11. Run `npm install`, `npm run build`, `npm run lint`. Smoke-test the binary: `npm run dev` (with MCP) and `npm run dev:llm` (LLM-only) from `packages/llm-agent-server`.
12. Add a single `patch` changeset entry for the fixed group → all five packages bump to 12.0.1.
13. Update `docs/ARCHITECTURE.md` and per-package READMEs (new layout, migration tables).
14. Open PR referencing #125.

## Risks and mitigations

- **Internal version drift.** Mitigated by the changesets `fixed` group — all five packages always share a version, so internal peer-range mismatch is impossible.
- **Circular imports between new packages.** `llm-agent-libs` depends on `llm-agent-mcp` and `llm-agent-rag`, never the other way. Step 3 (interface moves) lands first and `tsc --noEmit` must be clean before later steps. After steps 4–6, run `tsc --noEmit` again at workspace level to confirm no cycles.
- **Optional peer drift.** `llm-agent-libs` LLM peers and `llm-agent-rag` embedder/RAG peers must mirror the ranges in current `llm-agent-server@12.0.0`. Copy verbatim, then bump to `^12.0.0` if needed.
- **`llm-agent-server` no longer exports a library.** Any consumer still importing from it after upgrading to 12.0.1 will get a resolution error. This is the intended end-state and is in release notes; per the v12 contract no consumer should have been importing from server in the first place.
- **`package.json` without `main`/`exports`.** Some bundlers warn. If it causes friction, set `"exports": { "./package.json": "./package.json" }` to keep package metadata resolvable while still preventing library imports.
- **Tests located by path.** Implementation tests must move alongside the code; otherwise coverage disappears from the package that now owns the behaviour.
- **Lockfile churn.** `package-lock.json` changes are committed alongside the refactor per repo convention.
- **`makeLlm` / `makeDefaultLlm` / `makeRag` become async.** All internal callsites (notably `SmartAgentBuilder.build()`, which is already async) gain `await`. The known external callsite (`cloud-llm-hub/tools/generate-tool-intents.ts`) gets one `await` in the same migration commit that rewrites its import path. Risk: an undiscovered sync callsite passes a `Promise<ILlm>` / `Promise<IRag>` where the bare interface is expected — caught by `tsc --noEmit`, which must run clean before merging.

## Out of scope

- Adding new unit tests beyond relocating existing ones.
- Restructuring interfaces beyond what is needed to relocate them.
- Changing any provider/embedder/RAG leaf package beyond optional peer range alignment and any lockfile changes. The static-import → dynamic-import conversion happens entirely inside `llm-agent-libs` / `llm-agent-rag`; provider packages themselves are not modified.
- Promoting individual leaves out of `llm-agent-libs` into their own packages — see "Future split criteria" for when that becomes warranted.
