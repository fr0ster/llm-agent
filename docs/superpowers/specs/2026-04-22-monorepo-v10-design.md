# Monorepo Restructure — Design Spec

**Date:** 2026-04-22
**Target release:** v10.0.0 (major, breaking)
**Status:** Draft → In Review
**Builds on:** v9.1.0

## Motivation

Today the single `@mcp-abap-adt/llm-agent` package ships everything: interfaces, lightweight helpers, the full `SmartAgent` implementation, LLM providers with heavy SDK dependencies (`@sap-ai-sdk/*`, `@modelcontextprotocol/sdk`, `axios`), the MCP transport layer, the HTTP server, the CLI. A consumer who writes their own agent on top of our interfaces still pulls in every concrete default and every SDK. The roadmap for lightweight consumers ("I just want the interfaces and one backend") and lightweight deployments ("my backend is tiny; I don't want the full SAP stack") requires splitting the package.

v10.0.0 does the **infrastructure step**: turn the repo into an npm workspace monorepo and split the code into two packages:
- `@mcp-abap-adt/llm-agent` — interfaces, types, and reusable default building blocks with a smaller public surface than today's all-in-one package.
- `@mcp-abap-adt/llm-agent-server` — the full default agent implementation, LLM providers, MCP client, HTTP server, CLI.

v10.0.0 is only the start of that separation. Future releases (10.1.0+) can incrementally extract individual LLM providers and other environment-specific implementations into their own packages without another major bump. The target end state is a lightweight `@mcp-abap-adt/llm-agent` core package with minimal runtime dependencies.

## Scope

### In scope

- Convert the single-package repo into npm workspaces with two initial packages.
- Move existing code between the two packages along the split lines below.
- Wire TypeScript project references so the build graph is correct and `llm-agent` is compiled before `llm-agent-server`.
- Add `@changesets/cli` for lock-step versioning and release flow.
- Update CI (`ci.yml`, `release.yml`) for workspaces.
- Move the `llm-agent` CLI bin into `llm-agent-server`.
- Write a migration document for consumers.
- Ship v10.0.0 with both packages at the same version.

### Out of scope

- Extracting individual LLM providers (`openai-provider`, `anthropic-provider`, `sap-aicore-provider`, `ollama-provider`) into their own packages. Planned for 10.1.0+.
- Creating `@mcp-abap-adt/hana-vector-provider`. That work lives in a separate project.
- Any behavioral change to existing classes or interfaces. This is a reorganization, not a rewrite.
- Automated npm publish from CI. The first v10.0.0 publish happens manually by the maintainer; future releases may adopt a `changesets/action` workflow, but the workflow change is not required for v10.0.0.

## Resolved questions

| # | Question | Decision |
|---|---|---|
| 1 | Scope of v10.0.0 | Infra-only — monorepo + core/server split. No provider extraction. |
| 2 | Which package owns `VectorRag` / `QdrantRag` / providers? | All in core, because they add no SDK dependencies. |
| 3 | Migration strategy | In-place restructure with `git mv` to preserve blame. |
| 4 | Versioning | Fixed lock-step via Changesets: `{ "fixed": [["@mcp-abap-adt/llm-agent", "@mcp-abap-adt/llm-agent-server"]] }`. |
| 5 | CLI bin ownership | Server owns all three runtime bins: `llm-agent` (primary), `llm-agent-check` (diagnostics), `claude-via-agent` (dev wrapper to Claude CLI via SmartServer). No bin is dropped. |

## Package split

### `@mcp-abap-adt/llm-agent` (core)

**Content:**
- `src/smart-agent/interfaces/` — all public interfaces: `IRag`, `IRagEditor`, `IRagProvider`, `IRagProviderRegistry`, `IRagRegistry`, `IRagBackendWriter`, `IIdStrategy`, `IEmbedder`, `ILlm`, `IMcpClient`, `IPipeline`, `IClassifier`, `IAssembler`, `IHistoryMemory`, `IHistorySummarizer`, `ISkillManager`, `IToolCache`, `IToolPolicy`, `IOutputValidator`, `ILogger`, `ISessionManager`, `IReranker`, `IQueryExpander`, `IInjectionDetector`, `IModelProvider`, `ILlmCallStrategy`, `IMcpConnectionStrategy`, `IClientAdapter`, `IApiAdapter`, and related type files (`query-embedding.ts`, `types.ts`, `pipeline.ts`, etc.).
- `src/smart-agent/rag/` — the entire RAG infrastructure that exists today:
  - Backends: `InMemoryRag`, `VectorRag`, `QdrantRag`, `OllamaRag`.
  - Embedders: `OpenAiEmbedder`, `OllamaEmbedder`, `SapAiCoreEmbedder` (note: the embedder wrappers themselves stay in core despite depending on `axios` and SAP SDK — revisit in 10.1.0+ when provider extraction begins).
  - Providers: `AbstractRagProvider`, `InMemoryRagProvider`, `VectorRagProvider`, `QdrantRagProvider`, `SimpleRagProviderRegistry`.
  - Registry: `SimpleRagRegistry`.
  - Strategies: `DirectEditStrategy`, `ImmutableEditStrategy`, `OverlayEditStrategy`, `SessionScopedEditStrategy`, `CallerProvidedIdStrategy`, `GlobalUniqueIdStrategy`, `SessionScopedIdStrategy`, `CanonicalKeyIdStrategy`.
  - Overlays: `OverlayRag`, `SessionScopedRag`.
  - Corrections: `ActiveFilteringRag`, metadata helpers, error types.
  - Search strategies, inverted index, query embedding, preprocessor, embedder factories, tool indexing strategy, MCP tool factory (`buildRagCollectionToolEntries`).
- `src/types.ts` — shared top-level types (`Message`, `ToolCall`, `LLMResponse`, `LLMProviderConfig`, `AgentResponse`, etc.) if they are generic enough. Per-package judgment call during migration; if a type is only consumed by server-side code it moves with its consumer.

**Rule of thumb:** embedder wrapping tools that depend on an SDK (e.g. `@sap-ai-sdk/*`) count as "heavy" but are left in core for v10.0.0 because moving them requires a proper provider-extraction pass. This is explicit tech debt documented in the "Known debt" section below and addressed in 10.1.0+.

**Dependencies:** `zod`, and for now `axios` (Qdrant HTTP client) + `@sap-ai-sdk/*` (SAP embedder). After provider extraction in 10.1.0+ these will move out.

**Positioning note:** despite the split, v10.0.0 core is **not yet "zero heavy dependencies"**. The benefit of v10.0.0 is that it establishes the package boundaries needed for incremental extraction. Dependency minimization happens in follow-up releases as concrete implementations move into dedicated packages.

### `@mcp-abap-adt/llm-agent-server` (default implementation)

**Content:**
- `src/smart-agent/agent.ts` — `SmartAgent` class.
- `src/smart-agent/builder.ts` — `SmartAgentBuilder`.
- `src/smart-agent/pipeline/` — `DefaultPipeline`, pipeline context, all stage handlers (`classify.ts`, `rag-query.ts`, `tool-select.ts`, `tool-loop.ts`, `skill-select.ts`, `build-tool-query.ts`, `history-upsert.ts`, `assemble.ts`, etc.).
- `src/smart-agent/interfaces/*` that describe internal server contracts (`pipeline.ts`'s `PipelineDeps` / `SmartAgentDeps`) if they reference internal-only symbols — otherwise keep in core.
- `src/smart-agent/skills/` — skill managers (Claude, Codex, FileSystem).
- `src/smart-agent/resilience/` — `FallbackRag`, `CircuitBreaker`, `RetryLlm`, `RateLimiterLlm`, `CircuitBreakerLlm`.
- `src/smart-agent/cli.ts` — CLI entry.
- `src/smart-agent/smart-server.ts` — HTTP server + hot-reload logic.
- `src/smart-agent/testing/` — test helpers (`makeDefaultDeps`, stub LLMs, etc.).
- `src/smart-agent/tracer/`, `src/smart-agent/otel/`, `src/smart-agent/health/`, `src/smart-agent/metrics/` — observability layer.
- `src/smart-agent/cache/` — `ToolCache` + related.
- `src/smart-agent/session/` — `SessionManager` impl if present.
- `src/smart-agent/adapters/` — API adapters.
- `src/llm-providers/` — `OpenAIProvider`, `AnthropicProvider`, `DeepSeekProvider`, `SapCoreAIProvider`, `BaseLLMProvider`.
- `src/agents/` — the non-SmartAgent agent hierarchy (`BaseAgent`, `OpenAIAgent`, `AnthropicAgent`, `DeepSeekAgent`, `SapCoreAIAgent`, `PromptBasedAgent`) if it still exists in the repo at migration time.
- `src/mcp/` — MCP client wrapper and transports (stdio, SSE, stream-http, embedded, auto).
- `bin/llm-agent` — primary CLI shebang entry.
- `bin/llm-agent-check` — diagnostics CLI shebang entry.
- `bin/claude-via-agent` — dev convenience wrapper that launches the Claude CLI through a SmartServer. Script lives at `packages/llm-agent-server/tools/claude-via-agent.{sh,ps1}` and is included in `files` for publish.
- `scripts/generate-version.js` — build-time version-injection script.

**Dependencies:**
- Internal: `@mcp-abap-adt/llm-agent@workspace:*`
- Runtime: `axios`, `@modelcontextprotocol/sdk`, `@sap-ai-sdk/orchestration`, `@sap-ai-sdk/foundation-models`, `yaml`, `zod`.
- Peer / optional peer deps carried forward from v9 where still applicable: `@opentelemetry/api`, `@sap-ai-sdk/ai-api`.

## Repository layout (after migration)

```
llm-agent/
├── package.json                         ← root: workspaces + dev-deps
├── package-lock.json
├── tsconfig.base.json                   ← NEW: shared compiler options
├── biome.json                           ← existing, unchanged
├── .changeset/
│   └── config.json                      ← fixed group: [core, server]
├── .github/
│   └── workflows/
│       ├── ci.yml                       ← updated: --workspaces
│       └── release.yml                  ← updated: tag v* still triggers GitHub release
├── packages/
│   ├── llm-agent/
│   │   ├── package.json
│   │   ├── tsconfig.json                ← extends root, no references
│   │   ├── README.md
│   │   ├── CHANGELOG.md                 ← per-package changesets output
│   │   └── src/
│   │       ├── interfaces/
│   │       ├── rag/
│   │       ├── types.ts                 ← moved from src/
│   │       └── index.ts                 ← public exports
│   └── llm-agent-server/
│       ├── package.json
│       ├── tsconfig.json                ← extends root, references llm-agent
│       ├── README.md
│       ├── CHANGELOG.md
│       ├── bin/
│       │   ├── llm-agent                ← shebang → ./dist/smart-agent/cli.js
│       │   └── llm-agent-check          ← shebang → ./dist/smart-agent/check-models-cli.js
│       └── src/
│           ├── smart-agent/
│           ├── llm-providers/
│           ├── mcp/
│           └── index.ts
├── docs/                                ← stays at repo root
├── examples/                            ← stays at repo root; not published
├── scripts/
│   └── generate-version.js              ← or move into packages/llm-agent-server/scripts/
├── CHANGELOG.md                         ← repo-level aggregate changelog
└── README.md                            ← repo-level README pointing at each package
```

## Root-level files

### `package.json` (root, not published)

```json
{
  "name": "llm-agent-monorepo",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "tsc -b packages/llm-agent packages/llm-agent-server",
    "clean": "npm run clean --workspaces --if-present",
    "lint": "biome check --write packages scripts docs examples",
    "lint:check": "biome check packages scripts docs examples",
    "format": "biome format --write packages scripts docs examples",
    "test": "npm run test --workspaces --if-present",
    "changeset": "changeset",
    "version": "changeset version",
    "release": "npm run build && changeset publish"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.x",
    "@changesets/cli": "^2.x",
    "typescript": "^5.x",
    "tsx": "^4.x"
  }
}
```

The root `package.json` is **not published**; it's marked `"private": true`.

### `tsconfig.base.json`

Contains the compiler options common to both packages (strict mode, module resolution, target, lib). Each package's `tsconfig.json` extends it.

### `.changeset/config.json`

```json
{
  "$schema": "https://unpkg.com/@changesets/config@2.3.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [["@mcp-abap-adt/llm-agent", "@mcp-abap-adt/llm-agent-server"]],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

The `fixed` array enforces lock-step versioning: any changeset that bumps one also bumps the other.

## Per-package `package.json` shapes

### `packages/llm-agent/package.json`

```json
{
  "name": "@mcp-abap-adt/llm-agent",
  "version": "10.0.0",
  "description": "Core interfaces, types, and lightweight default implementations for LLM agent orchestration.",
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
    "clean": "rimraf dist",
    "test": "node --import tsx/esm --test --test-reporter=spec src/**/*.test.ts"
  },
  "dependencies": {
    "axios": "^1.x",
    "zod": "^3.x",
    "@sap-ai-sdk/foundation-models": "^x",
    "@sap-ai-sdk/orchestration": "^x"
  },
  "publishConfig": { "access": "public" }
}
```

**Note:** `axios` and SAP SDK stay here for v10.0.0 because `QdrantRag` and `SapAiCoreEmbedder` live in core. Planned to move in 10.1.0+ along with provider extraction.

### `packages/llm-agent-server/package.json`

```json
{
  "name": "@mcp-abap-adt/llm-agent-server",
  "version": "10.0.0",
  "description": "Default SmartAgent implementation, LLM providers, MCP client, HTTP server, and CLI.",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "llm-agent": "bin/llm-agent",
    "llm-agent-check": "bin/llm-agent-check",
    "claude-via-agent": "tools/claude-via-agent.sh"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    },
    "./testing": {
      "types": "./dist/smart-agent/testing/index.d.ts",
      "import": "./dist/smart-agent/testing/index.js",
      "default": "./dist/smart-agent/testing/index.js"
    },
    "./smart-server": {
      "types": "./dist/smart-agent/smart-server.d.ts",
      "import": "./dist/smart-agent/smart-server.js",
      "default": "./dist/smart-agent/smart-server.js"
    },
    "./otel": {
      "types": "./dist/smart-agent/otel/index.d.ts",
      "import": "./dist/smart-agent/otel/index.js",
      "default": "./dist/smart-agent/otel/index.js"
    }
  },
  "files": ["dist", "bin", "tools", "README.md", "LICENSE"],
  "scripts": {
    "prebuild": "node scripts/generate-version.js",
    "build": "tsc -p tsconfig.json",
    "clean": "rimraf dist",
    "test": "node --import tsx/esm --test --test-reporter=spec src/**/*.test.ts"
  },
  "dependencies": {
    "@mcp-abap-adt/llm-agent": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.x",
    "axios": "^1.x",
    "yaml": "^2.x",
    "zod": "^3.x"
  },
  "peerDependencies": {
    "@opentelemetry/api": "^1.x",
    "@sap-ai-sdk/ai-api": "^2.x"
  },
  "peerDependenciesMeta": {
    "@opentelemetry/api": { "optional": true },
    "@sap-ai-sdk/ai-api": { "optional": true }
  },
  "publishConfig": { "access": "public" }
}
```

Sub-exports (`./testing`, `./smart-server`, `./otel`) preserve the current 9.x shape so consumers' deep imports keep working after updating the package name.

## Published surface compatibility

v10.0.0 is a package split, but it still changes the published surface. We should enumerate those changes explicitly rather than let them emerge accidentally during file moves.

**Exports and bins to preserve intentionally:**
- `@mcp-abap-adt/llm-agent-server` continues to expose `./testing`, `./smart-server`, and `./otel`.
- `@mcp-abap-adt/llm-agent-server` owns the runtime CLIs: `llm-agent` and `llm-agent-check`.
- `@mcp-abap-adt/llm-agent` has no bin entries.

**Surface intentionally preserved:**
- All three v9 bins — `llm-agent`, `llm-agent-check`, `claude-via-agent` — remain available after the split and are owned by `@mcp-abap-adt/llm-agent-server`.

**Migration doc requirement:**
- `docs/MIGRATION-v10.md` must call out every removed, renamed, or moved `bin` and every moved deep-import entrypoint.

## TypeScript project references

### `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

### `packages/llm-agent/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["**/__tests__/**", "dist"]
}
```

### `packages/llm-agent-server/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["**/__tests__/**", "dist"],
  "references": [
    { "path": "../llm-agent" }
  ]
}
```

With `composite: true` and `references`, `tsc --build packages/llm-agent-server` builds core first, then the server. The root build should use `tsc -b` explicitly rather than rely on npm workspace execution order as a build guarantee.

## Import rewrites

The only code change of this refactor is in `packages/llm-agent-server/src/**/*.ts`: any import that used to read `'../interfaces/...'`, `'../rag/...'`, `'../types.js'`, etc. — and now refers to a symbol that lives in core — must change to `'@mcp-abap-adt/llm-agent'`.

We need to be exhaustive. A representative transformation:

```ts
// Before (in current src/smart-agent/agent.ts)
import type { IRag } from './interfaces/rag.js';
import type { Message } from '../types.js';
import { SmartAgentError } from './interfaces/types.js';

// After (in packages/llm-agent-server/src/smart-agent/agent.ts)
import type { IRag, Message, SmartAgentError } from '@mcp-abap-adt/llm-agent';
// SmartAgentError is a class — imported as a value, not type. Split the two.
import type { IRag, Message } from '@mcp-abap-adt/llm-agent';
import { SmartAgentError } from '@mcp-abap-adt/llm-agent';
```

**Tool:** a scripted codemod is out of scope for v10.0.0. Manual rewrites (TypeScript will fail loudly and point to every unresolved import) are fast enough because tsserver auto-imports the right module once the workspace is wired. The implementation plan treats this as a bounded, mechanical step.

## CLI bin mechanics

`packages/llm-agent-server/bin/llm-agent` is a 2-line shebang wrapper:

```
#!/usr/bin/env node
import('../dist/smart-agent/cli.js');
```

With `bin: { "llm-agent": "bin/llm-agent" }` in `package.json`, consumers installing `@mcp-abap-adt/llm-agent-server` get the `llm-agent` command on `PATH` (or via `npx`). Globally installed or local workspace — the ergonomics match today's behavior.

`packages/llm-agent-server/bin/llm-agent-check` follows the same pattern and points to `./dist/smart-agent/check-models-cli.js`.

## Examples and docs

- `examples/docker-*` stays at repo root and remains out of npm publish scope (they are docs artifacts, not importable code).
- `docs/` stays at repo root. Per-package READMEs live inside each package and link back to the repo root for deeper content.
- Repo root `README.md` gets rewritten to a thin "monorepo index" that explains the two packages and points at per-package READMEs and `docs/`.

## CI changes

### `ci.yml` (existing)

Replace any `npm run build` / `npm run test` / `npm run lint` that operate on the old single-package `src/` tree with monorepo-aware equivalents:

```yaml
- run: npm ci
- run: npm run lint:check
- run: npm run build
- run: npm run test
```

The key point is that CI must stop referencing root `src/` once the move is complete. Individual test runner lines that hard-code `src/smart-agent/...` paths must be updated or removed; each package owns its own test runner config.

### `release.yml` (existing)

Current trigger: `tags: ['v*']` → creates GitHub release. That stays. The first v10.0.0 publish is manual — the maintainer runs `npm run release` after merging. In a follow-up we may introduce `changesets/action` on push-to-main, but that is **not** required for v10.0.0.

## Migration for consumers — `docs/MIGRATION-v10.md`

A new doc that lists, as a table:

| Import in v9.x | Import in v10.0 | Package |
|---|---|---|
| `SmartAgent`, `SmartAgentBuilder` | same names | `@mcp-abap-adt/llm-agent-server` |
| `IRag`, `IRagEditor`, `IRagRegistry`, interface types | same names | `@mcp-abap-adt/llm-agent` |
| `InMemoryRag`, `VectorRag`, `QdrantRag` | same names | `@mcp-abap-adt/llm-agent` |
| `OpenAIProvider`, `AnthropicProvider`, `DeepSeekProvider`, `SapCoreAIProvider` | same names | `@mcp-abap-adt/llm-agent-server` |
| `FallbackRag`, `CircuitBreaker` | same names | `@mcp-abap-adt/llm-agent-server` |
| `RagError`, `LlmError`, `ReadOnlyError`, etc. | same names | `@mcp-abap-adt/llm-agent` |
| `buildRagCollectionToolEntries` | same name | `@mcp-abap-adt/llm-agent` |
| `DefaultPipeline`, pipeline handlers | same names | `@mcp-abap-adt/llm-agent-server` |
| `MCPClientWrapper`, transports | same names | `@mcp-abap-adt/llm-agent-server` |
| `llm-agent` CLI | same command | `@mcp-abap-adt/llm-agent-server` |
| `llm-agent-check` CLI | same command | `@mcp-abap-adt/llm-agent-server` |
| `claude-via-agent` CLI | same command | `@mcp-abap-adt/llm-agent-server` |

**Install changes:**
```bash
# Before (v9.x)
npm install @mcp-abap-adt/llm-agent

# After (v10.0), using the default SmartAgent
npm install @mcp-abap-adt/llm-agent-server
# (transitively pulls in @mcp-abap-adt/llm-agent)

# After (v10.0), writing a custom agent on our interfaces only
npm install @mcp-abap-adt/llm-agent
```

**CLI changes:**
```bash
# Before
npx @mcp-abap-adt/llm-agent --config smart-server.yaml

# After
npx @mcp-abap-adt/llm-agent-server --config smart-server.yaml
# Global install still exposes `llm-agent` binary.

# Diagnostics CLI after
npx @mcp-abap-adt/llm-agent-server llm-agent-check
```

## Known debt

- `axios` and `@sap-ai-sdk/*` remain runtime dependencies of `@mcp-abap-adt/llm-agent` because `QdrantRag` and `SapAiCoreEmbedder` live in core. Moving them out requires extracting provider packages, which is explicitly out of scope here. **Remediation:** 10.1.0+ extracts those providers; at that point core's runtime deps shrink to `zod`.
- A consumer who writes a truly minimal agent on our interfaces today still pays for `axios` and SAP SDK. Documented in the `README` with a note that 10.1.0 shrinks the core footprint.

## Testing

- Existing test suites move with their code (core tests → core package, server tests → server package).
- `npm run test` at the root runs both via `--workspaces`.
- The first build+test loop is the main verification: if every import resolves and every test that passed on 9.1.0 continues to pass, the restructure is correct.
- One explicit regression test: `examples/docker-ollama/` and `examples/docker-deepseek/` build succeed. They reference `@mcp-abap-adt/llm-agent-server` (post-migration) and the CLI launches. Automated smoke via `npm run test` runs a reduced version of this.

## Release flow (once per release)

1. After all changes land on main, a maintainer runs `npx changeset` and documents the changes (content matches the spec notes).
2. `npm run version` (or `npx changeset version`) bumps versions in both `package.json`s to `10.0.0` and updates per-package `CHANGELOG.md`.
3. Commit the version bump.
4. `npm run build` — verify both packages build.
5. `npm publish --access public` in `packages/llm-agent` and `packages/llm-agent-server`.
6. Tag: `git tag v10.0.0 && git push origin v10.0.0`. GitHub release workflow picks it up and creates a release page.

## Open items for implementation plan

- Whether `src/smart-agent/testing/` moves fully into server, or we keep a subset in core for shared test helpers (e.g., stub `IRag` factories) that both packages use. Lean: keep everything in server; core tests can write their own small stubs.
- Exact boundary of interface files: some interfaces (e.g., `PipelineDeps`, `SmartAgentDeps`) mix core types with server-only types. Plan task 4 resolves this explicitly — may require splitting a file into a core-facing and server-facing piece.
- Whether `docs/superpowers/` directory policy (delete after implementation) applies cleanly after the monorepo move. It does — it stays at repo root.
