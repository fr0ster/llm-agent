# llm-agent-libs Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the v12 package split by introducing `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`, and `@mcp-abap-adt/llm-agent-libs`, leaving `@mcp-abap-adt/llm-agent-server` as a binary-only package. Convert top-level LLM and RAG factories to async dynamic-import to fulfill the optional-peer promise.

**Architecture:** Five-package SmartAgent family bound by a changesets `fixed` group. Composition flows `server → libs → {mcp, rag} → llm-agent`. LLM/embedder/RAG provider leaves remain optional peers, loaded via dynamic `import()` at first use.

**Tech Stack:** TypeScript ESM, npm workspaces, Biome, changesets, `node --test` with `tsx`, no bundler.

**Spec:** `docs/superpowers/specs/2026-04-28-llm-agent-libs-split-design.md`

**Verification model:** This monorepo has no Jest/Vitest. Verification per task is one or more of:
- `npx tsc -b` from repo root (workspace build) — must pass clean.
- `npx tsc --noEmit -p packages/<pkg>` for a single package check.
- Existing test suite: `npm run test --workspace @mcp-abap-adt/llm-agent-server` (uses `node --test`).
- Binary smoke tests: `npm run dev:llm` and `npm run dev` (with MCP) from repo root.

**Reference symbols already in `@mcp-abap-adt/llm-agent`** (do NOT duplicate):
- `LLMProviderConfig` (uppercase) in `src/types.ts`
- `AgentCallOptions` in `src/interfaces/agent-contracts.ts`
- `MissingProviderError` in `src/errors/`
- `IRag`, `VectorRag`, `IEmbedder`, `Message`, `CallOptions`, `IntentEnricher`, `TextOnlyEmbedding`, etc.

---

## Task 1: Narrow changesets fixed group

**Goal:** Restrict the changesets `fixed` group to the five SmartAgent family packages only. Provider/embedder/RAG leaves leave the group.

**Files:**
- Modify: `.changeset/config.json`

- [ ] **Step 1: Edit `.changeset/config.json`**

Replace the `fixed` array with:

```json
"fixed": [
  [
    "@mcp-abap-adt/llm-agent",
    "@mcp-abap-adt/llm-agent-mcp",
    "@mcp-abap-adt/llm-agent-rag",
    "@mcp-abap-adt/llm-agent-libs",
    "@mcp-abap-adt/llm-agent-server"
  ]
]
```

Leave all other fields unchanged.

- [ ] **Step 2: Verify config parses**

Run: `npx changeset status`
Expected: command exits 0, prints "No changesets present" or current pending status (no parse errors).

- [ ] **Step 3: Commit**

```bash
git add .changeset/config.json
git commit -m "chore(changesets): narrow fixed group to SmartAgent family"
```

---

## Task 2: Scaffold `@mcp-abap-adt/llm-agent-mcp`

**Goal:** Create the empty `llm-agent-mcp` package with build pipeline wired into the workspace.

**Files:**
- Create: `packages/llm-agent-mcp/package.json`
- Create: `packages/llm-agent-mcp/tsconfig.json`
- Create: `packages/llm-agent-mcp/src/index.ts`
- Create: `packages/llm-agent-mcp/biome.json` (extends root)
- Create: `packages/llm-agent-mcp/README.md`
- Modify: `package.json` (root) — add to `build` and `clean` scripts

- [ ] **Step 1: Create `packages/llm-agent-mcp/package.json`**

```json
{
  "name": "@mcp-abap-adt/llm-agent-mcp",
  "version": "12.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "tsc -p tsconfig.json --clean"
  },
  "dependencies": {
    "@mcp-abap-adt/llm-agent": "*",
    "@modelcontextprotocol/sdk": "^1.28.0"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

Mirror version range of `@modelcontextprotocol/sdk` from `packages/llm-agent-server/package.json` if it differs.

- [ ] **Step 2: Create `packages/llm-agent-mcp/tsconfig.json`**

```json
{
  "extends": "../llm-agent/tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "**/__tests__/**"],
  "references": [
    { "path": "../llm-agent" }
  ]
}
```

- [ ] **Step 3: Create `packages/llm-agent-mcp/src/index.ts`**

```ts
export {};
```

- [ ] **Step 4: Create `packages/llm-agent-mcp/biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.13/schema.json",
  "extends": ["//"]
}
```

(Use the same biome version as root `biome.json`.)

- [ ] **Step 5: Create `packages/llm-agent-mcp/README.md`**

```markdown
# @mcp-abap-adt/llm-agent-mcp

MCP client wrapper, adapter, and connection strategies for `@mcp-abap-adt/llm-agent-libs`.

See `docs/ARCHITECTURE.md` for the full SmartAgent package layout.
```

- [ ] **Step 6: Add to root `package.json` build/clean scripts**

In root `package.json`, replace the `build` and `clean` scripts:

```json
"build": "tsc -b packages/llm-agent packages/llm-agent-mcp packages/openai-llm packages/anthropic-llm packages/openai-embedder packages/ollama-embedder packages/qdrant-rag packages/sap-aicore-llm packages/sap-aicore-embedder packages/deepseek-llm packages/hana-vector-rag packages/pg-vector-rag packages/llm-agent-server",
"clean": "tsc -b --clean packages/llm-agent packages/llm-agent-mcp packages/openai-llm packages/anthropic-llm packages/openai-embedder packages/ollama-embedder packages/qdrant-rag packages/sap-aicore-llm packages/sap-aicore-embedder packages/deepseek-llm packages/hana-vector-rag packages/pg-vector-rag packages/llm-agent-server"
```

Insert `packages/llm-agent-mcp` immediately after `packages/llm-agent`.

- [ ] **Step 7: Install workspace and verify build**

Run: `npm install`
Expected: success; `node_modules/@mcp-abap-adt/llm-agent-mcp` symlink created.

Run: `npx tsc -b packages/llm-agent packages/llm-agent-mcp`
Expected: success, `packages/llm-agent-mcp/dist/index.js` produced.

- [ ] **Step 8: Commit**

```bash
git add packages/llm-agent-mcp/ package.json package-lock.json
git commit -m "chore(llm-agent-mcp): scaffold empty package"
```

---

## Task 3: Scaffold `@mcp-abap-adt/llm-agent-rag`

**Goal:** Create the empty `llm-agent-rag` package with optional embedder/RAG peers.

**Files:**
- Create: `packages/llm-agent-rag/{package.json,tsconfig.json,biome.json,src/index.ts,README.md}`
- Modify: `package.json` (root) — add to `build`/`clean`

- [ ] **Step 1: Create `packages/llm-agent-rag/package.json`**

```json
{
  "name": "@mcp-abap-adt/llm-agent-rag",
  "version": "12.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "tsc -p tsconfig.json --clean"
  },
  "dependencies": {
    "@mcp-abap-adt/llm-agent": "*"
  },
  "peerDependencies": {
    "@mcp-abap-adt/openai-embedder": "^12.0.0",
    "@mcp-abap-adt/ollama-embedder": "^12.0.0",
    "@mcp-abap-adt/sap-aicore-embedder": "^12.0.0",
    "@mcp-abap-adt/qdrant-rag": "^12.0.0",
    "@mcp-abap-adt/hana-vector-rag": "^12.0.0",
    "@mcp-abap-adt/pg-vector-rag": "^12.0.0"
  },
  "peerDependenciesMeta": {
    "@mcp-abap-adt/openai-embedder": { "optional": true },
    "@mcp-abap-adt/ollama-embedder": { "optional": true },
    "@mcp-abap-adt/sap-aicore-embedder": { "optional": true },
    "@mcp-abap-adt/qdrant-rag": { "optional": true },
    "@mcp-abap-adt/hana-vector-rag": { "optional": true },
    "@mcp-abap-adt/pg-vector-rag": { "optional": true }
  },
  "devDependencies": {
    "@mcp-abap-adt/openai-embedder": "*",
    "@mcp-abap-adt/ollama-embedder": "*",
    "@mcp-abap-adt/sap-aicore-embedder": "*",
    "@mcp-abap-adt/qdrant-rag": "*",
    "@mcp-abap-adt/hana-vector-rag": "*",
    "@mcp-abap-adt/pg-vector-rag": "*"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

- [ ] **Step 2: Create `packages/llm-agent-rag/tsconfig.json`**

```json
{
  "extends": "../llm-agent/tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "**/__tests__/**"],
  "references": [
    { "path": "../llm-agent" },
    { "path": "../openai-embedder" },
    { "path": "../ollama-embedder" },
    { "path": "../sap-aicore-embedder" },
    { "path": "../qdrant-rag" },
    { "path": "../hana-vector-rag" },
    { "path": "../pg-vector-rag" }
  ]
}
```

- [ ] **Step 3: Create stubs**

`packages/llm-agent-rag/src/index.ts`:
```ts
export {};
```

`packages/llm-agent-rag/biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.13/schema.json",
  "extends": ["//"]
}
```

`packages/llm-agent-rag/README.md`:
```markdown
# @mcp-abap-adt/llm-agent-rag

RAG and embedder composition (`makeRag`, `resolveEmbedder`, factories) for `@mcp-abap-adt/llm-agent-libs`.

See `docs/ARCHITECTURE.md` for the full SmartAgent package layout.
```

- [ ] **Step 4: Add to root build/clean**

Insert `packages/llm-agent-rag` after `packages/llm-agent-mcp` in both root `package.json` `build` and `clean` scripts.

- [ ] **Step 5: Install + build**

```bash
npm install
npx tsc -b packages/llm-agent packages/llm-agent-mcp packages/llm-agent-rag
```

Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-rag/ package.json package-lock.json
git commit -m "chore(llm-agent-rag): scaffold empty package"
```

---

## Task 4: Scaffold `@mcp-abap-adt/llm-agent-libs`

**Goal:** Create the empty `llm-agent-libs` package with subpath exports for `./testing` and `./otel`, optional LLM peers.

**Files:**
- Create: `packages/llm-agent-libs/{package.json,tsconfig.json,biome.json,src/index.ts,src/testing/index.ts,src/otel/index.ts,README.md}`
- Modify: root `package.json` build/clean

- [ ] **Step 1: Create `packages/llm-agent-libs/package.json`**

```json
{
  "name": "@mcp-abap-adt/llm-agent-libs",
  "version": "12.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./testing": {
      "types": "./dist/testing/index.d.ts",
      "import": "./dist/testing/index.js"
    },
    "./otel": {
      "types": "./dist/otel/index.d.ts",
      "import": "./dist/otel/index.js"
    }
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "tsc -p tsconfig.json --clean"
  },
  "dependencies": {
    "@mcp-abap-adt/llm-agent": "*",
    "@mcp-abap-adt/llm-agent-mcp": "*",
    "@mcp-abap-adt/llm-agent-rag": "*",
    "dotenv": "^17.3.1",
    "yaml": "^2.8.3",
    "zod": "^4.3.6"
  },
  "peerDependencies": {
    "@mcp-abap-adt/openai-llm": "^12.0.0",
    "@mcp-abap-adt/anthropic-llm": "^12.0.0",
    "@mcp-abap-adt/deepseek-llm": "^12.0.0",
    "@mcp-abap-adt/sap-aicore-llm": "^12.0.0"
  },
  "peerDependenciesMeta": {
    "@mcp-abap-adt/openai-llm": { "optional": true },
    "@mcp-abap-adt/anthropic-llm": { "optional": true },
    "@mcp-abap-adt/deepseek-llm": { "optional": true },
    "@mcp-abap-adt/sap-aicore-llm": { "optional": true }
  },
  "devDependencies": {
    "@mcp-abap-adt/openai-llm": "*",
    "@mcp-abap-adt/anthropic-llm": "*",
    "@mcp-abap-adt/deepseek-llm": "*",
    "@mcp-abap-adt/sap-aicore-llm": "*"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

If the current `llm-agent-server/package.json` has additional runtime deps (e.g. OpenTelemetry API packages), copy them here. Verify with `cat packages/llm-agent-server/package.json` and reconcile.

- [ ] **Step 2: Create `packages/llm-agent-libs/tsconfig.json`**

```json
{
  "extends": "../llm-agent/tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "**/__tests__/**"],
  "references": [
    { "path": "../llm-agent" },
    { "path": "../llm-agent-mcp" },
    { "path": "../llm-agent-rag" },
    { "path": "../openai-llm" },
    { "path": "../anthropic-llm" },
    { "path": "../deepseek-llm" },
    { "path": "../sap-aicore-llm" }
  ]
}
```

- [ ] **Step 3: Create stubs**

`packages/llm-agent-libs/src/index.ts`:
```ts
export {};
```

`packages/llm-agent-libs/src/testing/index.ts`:
```ts
export {};
```

`packages/llm-agent-libs/src/otel/index.ts`:
```ts
export {};
```

`packages/llm-agent-libs/biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.13/schema.json",
  "extends": ["//"]
}
```

`packages/llm-agent-libs/README.md`:
```markdown
# @mcp-abap-adt/llm-agent-libs

Core SmartAgent composition: builder, agent runtime, pipeline, sessions, history, resilience, observability, plugins, skills.

See `docs/ARCHITECTURE.md` for the full SmartAgent package layout.
```

- [ ] **Step 4: Add to root build/clean**

Insert `packages/llm-agent-libs` AFTER `packages/llm-agent-rag` and BEFORE `packages/llm-agent-server` in both `build` and `clean` scripts.

- [ ] **Step 5: Install + build**

```bash
npm install
npx tsc -b
```

Expected: full workspace build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-libs/ package.json package-lock.json
git commit -m "chore(llm-agent-libs): scaffold empty package with testing+otel subpaths"
```

---

## Task 5: Move type-only declarations into `@mcp-abap-adt/llm-agent`

**Goal:** Relocate all dependency-free interfaces and DTOs from `llm-agent-server/src/smart-agent/**` into `llm-agent/src/interfaces/`. Implementations in server keep importing them from `@mcp-abap-adt/llm-agent` for now.

**Files:**
- Create: `packages/llm-agent/src/interfaces/{metrics,validator,tracer,session,reranker,health,builder}.ts`
- Modify: `packages/llm-agent/src/interfaces/{plugin,agent-contracts,pipeline,index,request-logger}.ts`
- Modify: `packages/llm-agent/src/index.ts`
- Move: `packages/llm-agent-server/src/smart-agent/interfaces/{mcp-connection-strategy,model-resolver,pipeline}.ts` → `packages/llm-agent/src/interfaces/`
- Modify: server files that owned the original type declarations (strip type, import from `@mcp-abap-adt/llm-agent`)

The full source-of-truth list of types to move is in the spec. This task batches the work into smaller commits per group.

### Subtask 5a: Metrics, Validator, Tracer, Reranker, Session interfaces

- [ ] **Step 1: Create `packages/llm-agent/src/interfaces/metrics.ts`**

Open `packages/llm-agent-server/src/smart-agent/metrics/types.ts`, copy verbatim into the new file path. Adjust import paths if any (these are usually self-contained type files).

- [ ] **Step 2: Create `packages/llm-agent/src/interfaces/{validator,tracer,session,reranker}.ts`**

Same pattern: copy contents of:
- `llm-agent-server/src/smart-agent/validator/types.ts` → `packages/llm-agent/src/interfaces/validator.ts`
- `llm-agent-server/src/smart-agent/tracer/types.ts` → `packages/llm-agent/src/interfaces/tracer.ts`
- `llm-agent-server/src/smart-agent/session/types.ts` → `packages/llm-agent/src/interfaces/session.ts`
- `llm-agent-server/src/smart-agent/reranker/types.ts` → `packages/llm-agent/src/interfaces/reranker.ts`

- [ ] **Step 3: Re-export from `packages/llm-agent/src/interfaces/index.ts`**

Append:
```ts
export * from './metrics.js';
export * from './validator.js';
export * from './tracer.js';
export * from './session.js';
export * from './reranker.js';
```

- [ ] **Step 4: Convert original server type files to re-exports**

Replace the contents of each of the five server type files (e.g., `llm-agent-server/src/smart-agent/metrics/types.ts`) with a single line:

```ts
export * from '@mcp-abap-adt/llm-agent';
```

Use this pattern for the other four. This keeps internal imports inside server working unchanged for now; later steps drop these shims when the impls move.

- [ ] **Step 5: Build + verify**

```bash
npx tsc -b
```

Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent/src/interfaces/ packages/llm-agent-server/src/smart-agent/{metrics,validator,tracer,session,reranker}/types.ts
git commit -m "refactor(llm-agent): move metrics/validator/tracer/session/reranker types to interfaces/"
```

### Subtask 5b: Health DTOs and Plugin contract

- [ ] **Step 1: Create `packages/llm-agent/src/interfaces/health.ts`**

Copy `llm-agent-server/src/smart-agent/health/types.ts` (`HealthStatus`, `HealthComponentStatus`, `CircuitBreakerStatus`).

- [ ] **Step 2: Extend `packages/llm-agent/src/interfaces/plugin.ts`**

Open `llm-agent-server/src/smart-agent/plugins/index.ts` and copy the type/interface declarations (`IPluginLoader`, `LoadedPlugins`, `PluginExports` — but NOT `FileSystemPluginLoaderConfig`, which stays with the impl). Append them to `packages/llm-agent/src/interfaces/plugin.ts`. If that file does not exist, create it.

- [ ] **Step 3: Update `interfaces/index.ts`**

Add:
```ts
export * from './health.js';
export * from './plugin.js';
```

- [ ] **Step 4: Replace server originals with re-export shims**

`llm-agent-server/src/smart-agent/health/types.ts` → `export * from '@mcp-abap-adt/llm-agent';`
For `llm-agent-server/src/smart-agent/plugins/index.ts`: keep the runtime exports (classes/functions) intact, but for the moved types replace local declarations with `import type { IPluginLoader, LoadedPlugins, PluginExports } from '@mcp-abap-adt/llm-agent';` and re-export them: `export type { IPluginLoader, LoadedPlugins, PluginExports };`.

- [ ] **Step 5: Build + commit**

```bash
npx tsc -b
git add -A
git commit -m "refactor(llm-agent): move health DTOs and plugin contract types to interfaces/"
```

### Subtask 5c: Builder handle, BaseAgentLlmBridge, Pipeline DSL, MCP/model interfaces

- [ ] **Step 1: Create `packages/llm-agent/src/interfaces/builder.ts`**

Extract type `SmartAgentHandle` from `llm-agent-server/src/smart-agent/builder.ts` (and any reachable type-only deps it requires). Place in the new file.

- [ ] **Step 2: Extend `packages/llm-agent/src/interfaces/agent-contracts.ts`**

Append type `BaseAgentLlmBridge` (from `llm-agent-server/src/smart-agent/adapters/llm-adapter.ts`). Do NOT touch the existing `AgentCallOptions` already in this file — the server-side `AgentCallOptions` will be reconciled with it later (subtask 8). For now, leave server's local `AgentCallOptions` in place; cross-import will happen during step 8.

- [ ] **Step 3: Extend `packages/llm-agent/src/interfaces/pipeline.ts`**

Append the public pipeline DSL types from `llm-agent-server/src/smart-agent/pipeline/index.ts`: `StageDefinition`, `IStageHandler`, `PipelineContext`, `BuiltInStageType`, `ControlFlowType`, `StageType`. Create the file if it does not exist (likely it does, holding `IPipeline`, `PipelineDeps`, `PipelineResult`).

- [ ] **Step 4: Move MCP / model resolver interfaces**

Move three files as-is:
- `llm-agent-server/src/smart-agent/interfaces/mcp-connection-strategy.ts` → `packages/llm-agent/src/interfaces/mcp-connection-strategy.ts`
- `llm-agent-server/src/smart-agent/interfaces/model-resolver.ts` → `packages/llm-agent/src/interfaces/model-resolver.ts`
- `llm-agent-server/src/smart-agent/interfaces/pipeline.ts` → if this file's content is not already covered by step 3, merge it; otherwise delete the duplicate after merging.

In the **server**, replace each of these with re-export shims:
```ts
export * from '@mcp-abap-adt/llm-agent';
```

- [ ] **Step 5: Update `interfaces/index.ts`**

```ts
export * from './builder.js';
export * from './mcp-connection-strategy.js';
export * from './model-resolver.js';
// pipeline.js is presumed already exported; verify.
```

- [ ] **Step 6: Verify `request-logger.ts` types**

Open `packages/llm-agent/src/interfaces/request-logger.ts`. If `ILogger`/`LogEvent` are missing here but exist in `llm-agent-server/src/smart-agent/logger/types.ts`, add them; otherwise skip.

- [ ] **Step 7: Build + commit**

```bash
npx tsc -b
git add -A
git commit -m "refactor(llm-agent): move builder handle, pipeline DSL, MCP/model interfaces to interfaces/"
```

### Subtask 5d: Update `packages/llm-agent/src/index.ts`

- [ ] **Step 1: Add re-exports**

Open `packages/llm-agent/src/index.ts`. Confirm `export * from './interfaces/index.js';` already covers the new modules. If `interfaces/index.ts` exports them (it does after subtasks 5a–5c), no change here — but verify by `grep "interfaces/index"` and reading the file.

- [ ] **Step 2: Build + commit (if any change)**

```bash
npx tsc -b
git add -A
git commit -m "refactor(llm-agent): surface new interface modules from package index" || echo "no-op"
```

---

## Task 6: Move MCP code into `@mcp-abap-adt/llm-agent-mcp`

**Goal:** Migrate MCP client wrapper, adapter, factory, and connection strategies into `llm-agent-mcp`. Update `llm-agent-server` to import from the new package.

**Files:**
- Move:
  - `llm-agent-server/src/mcp/client.ts` → `llm-agent-mcp/src/client.ts`
  - `llm-agent-server/src/smart-agent/adapters/mcp-client-adapter.ts` → `llm-agent-mcp/src/adapter.ts`
  - `llm-agent-server/src/smart-agent/mcp-client-factory.ts` → `llm-agent-mcp/src/factory.ts`
  - `llm-agent-server/src/smart-agent/strategies/` (entire dir) → `llm-agent-mcp/src/strategies/`
- Move tests:
  - `llm-agent-server/src/smart-agent/__tests__/{mcp-reconnection,mcp-clients-di,noop-connection-strategy,periodic-connection-strategy,heartbeat,lazy-connection-strategy}.test.ts` → `llm-agent-mcp/src/__tests__/`
  - Adapter test `llm-agent-server/src/smart-agent/adapters/__tests__/mcp-client-adapter.test.ts` → `llm-agent-mcp/src/__tests__/`
- Modify: `packages/llm-agent-mcp/src/index.ts` — populate exports
- Modify: server files that imported the moved code — point to `@mcp-abap-adt/llm-agent-mcp`

- [ ] **Step 1: Move source files**

```bash
mkdir -p packages/llm-agent-mcp/src/strategies
git mv packages/llm-agent-server/src/mcp/client.ts packages/llm-agent-mcp/src/client.ts
git mv packages/llm-agent-server/src/smart-agent/adapters/mcp-client-adapter.ts packages/llm-agent-mcp/src/adapter.ts
git mv packages/llm-agent-server/src/smart-agent/mcp-client-factory.ts packages/llm-agent-mcp/src/factory.ts
git mv packages/llm-agent-server/src/smart-agent/strategies/* packages/llm-agent-mcp/src/strategies/
rmdir packages/llm-agent-server/src/smart-agent/strategies
rmdir packages/llm-agent-server/src/mcp 2>/dev/null || true
```

If `packages/llm-agent-server/src/mcp/` has other files (e.g. `README.md`), keep them there or relocate as fits. Verify with `ls packages/llm-agent-server/src/mcp/`.

- [ ] **Step 2: Rewrite imports inside moved files**

Open each moved file and replace any relative imports that crossed the package boundary:
- `from '../../../../llm-agent/src/...'` or similar → `from '@mcp-abap-adt/llm-agent'`
- Inter-MCP imports (e.g. adapter importing client) — adjust to the new local layout (`from './client.js'`, etc.)

Specifically:
- `adapter.ts`: was importing `MCPClientWrapper` from `'../../mcp/client.js'` → `from './client.js'`.
- `factory.ts`: was importing `MCPClientWrapper` from `'../mcp/client.js'` → `from './client.js'`.
- `strategies/*`: imports `MCPClientWrapper`, `IMcpConnectionStrategy` etc. — rewrite paths to local or `@mcp-abap-adt/llm-agent`.

- [ ] **Step 3: Populate `packages/llm-agent-mcp/src/index.ts`**

```ts
export {
  MCPClientWrapper,
  type MCPClientConfig,
  type TransportType,
} from './client.js';
export { McpClientAdapter } from './adapter.js';
export { createDefaultMcpClient } from './factory.js';
export {
  LazyConnectionStrategy,
  PeriodicConnectionStrategy,
  NoopConnectionStrategy,
} from './strategies/index.js';
```

If `strategies/` does not have a barrel `index.ts`, create one that re-exports the three strategy classes. Inspect existing files to find exact class names.

- [ ] **Step 4: Move tests**

```bash
mkdir -p packages/llm-agent-mcp/src/__tests__
git mv packages/llm-agent-server/src/smart-agent/__tests__/mcp-reconnection.test.ts packages/llm-agent-mcp/src/__tests__/
git mv packages/llm-agent-server/src/smart-agent/__tests__/mcp-clients-di.test.ts packages/llm-agent-mcp/src/__tests__/
git mv packages/llm-agent-server/src/smart-agent/__tests__/noop-connection-strategy.test.ts packages/llm-agent-mcp/src/__tests__/
git mv packages/llm-agent-server/src/smart-agent/__tests__/periodic-connection-strategy.test.ts packages/llm-agent-mcp/src/__tests__/
git mv packages/llm-agent-server/src/smart-agent/__tests__/heartbeat.test.ts packages/llm-agent-mcp/src/__tests__/
git mv packages/llm-agent-server/src/smart-agent/__tests__/lazy-connection-strategy.test.ts packages/llm-agent-mcp/src/__tests__/
git mv packages/llm-agent-server/src/smart-agent/adapters/__tests__/mcp-client-adapter.test.ts packages/llm-agent-mcp/src/__tests__/
```

For each test file: open it and rewrite relative cross-package imports:
- `from '../../mcp/client.js'` → `from '../client.js'`
- `from '../../adapters/mcp-client-adapter.js'` → `from '../adapter.js'`
- `from '../../strategies/...'` → `from '../strategies/...'`
- Any imports of moved types from llm-agent-server-internal paths → `from '@mcp-abap-adt/llm-agent'`

Add a `test` script to `packages/llm-agent-mcp/package.json`:
```json
"test": "node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'"
```

- [ ] **Step 5: Update server imports**

Find all server files that referenced the moved code:

```bash
grep -rn "from '\\(\\.\\./\\)*mcp/client\\|from '\\(\\.\\./\\)*smart-agent/adapters/mcp-client-adapter\\|from '\\(\\.\\./\\)*smart-agent/mcp-client-factory\\|from '\\(\\.\\./\\)*smart-agent/strategies" packages/llm-agent-server/src/
```

For each match, replace the relative import with:
```ts
import { MCPClientWrapper, McpClientAdapter, createDefaultMcpClient, LazyConnectionStrategy, PeriodicConnectionStrategy, NoopConnectionStrategy } from '@mcp-abap-adt/llm-agent-mcp';
```
(Pick only the symbols used in each file.)

- [ ] **Step 6: Add `@mcp-abap-adt/llm-agent-mcp` to server deps**

Open `packages/llm-agent-server/package.json`, add to `dependencies`:
```json
"@mcp-abap-adt/llm-agent-mcp": "*"
```

Add a tsconfig reference: in `packages/llm-agent-server/tsconfig.json`, ensure `references` includes `{ "path": "../llm-agent-mcp" }`.

- [ ] **Step 7: Install + build + run MCP-area tests**

```bash
npm install
npx tsc -b
npm run test --workspace @mcp-abap-adt/llm-agent-mcp
```

Expected: build clean, MCP tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(llm-agent-mcp): move MCP client wrapper, adapter, factory, strategies"
```

---

## Task 7: Move RAG/embedder code into `@mcp-abap-adt/llm-agent-rag`, convert factories to async

**Goal:** Migrate `embedder-factories.ts`, `rag-factories.ts`, and the RAG/embedder portion of `providers.ts` into `llm-agent-rag`. Convert top-level `makeRag()` and `resolveEmbedder()` to async. Extract sync `resolvePrefetchedEmbedder()` / `resolvePrefetchedRag()` from existing cached lookups.

**Files:**
- Move: `llm-agent-server/src/smart-agent/embedder-factories.ts` → `llm-agent-rag/src/embedder-factories.ts`
- Move: `llm-agent-server/src/smart-agent/rag-factories.ts` → `llm-agent-rag/src/rag-factories.ts`
- Modify: `llm-agent-server/src/smart-agent/providers.ts` (extract RAG helpers — `makeRag`, RAG resolution config types — move to `llm-agent-rag`)
- Move tests: embedder-factories.test.ts and any rag-factories test (`grep -l makeRag` or `embedder-factories` under server's `__tests__/`).
- Create: `packages/llm-agent-rag/src/index.ts` — populate exports
- Modify: server files that imported from these locations → import from `@mcp-abap-adt/llm-agent-rag`

- [ ] **Step 1: Move embedder/rag factory files**

```bash
git mv packages/llm-agent-server/src/smart-agent/embedder-factories.ts packages/llm-agent-rag/src/embedder-factories.ts
git mv packages/llm-agent-server/src/smart-agent/rag-factories.ts packages/llm-agent-rag/src/rag-factories.ts
```

- [ ] **Step 2: Extract RAG block from `providers.ts`**

Open `packages/llm-agent-server/src/smart-agent/providers.ts`. Locate `makeRag` (around line 313) and any RAG/embedder resolution helper types (`RagResolutionConfig`, `RagResolutionOptions`, `EmbedderResolutionConfig`, `EmbedderResolutionOptions`, `resolveEmbedder` if present here). Cut the entire RAG-related block.

Paste the cut content into `packages/llm-agent-rag/src/rag-factories.ts` at the bottom (or merge if functions overlap). Update its imports as needed.

Leave `providers.ts` with `makeLlm`, `DefaultModelResolver`, `makeDefaultLlm`, `LlmProviderConfig` only.

- [ ] **Step 3: Convert top-level `makeRag()` and `resolveEmbedder()` to async**

In `packages/llm-agent-rag/src/embedder-factories.ts` and `rag-factories.ts`:

a) For each provider used (`openai-embedder`, `ollama-embedder`, `sap-aicore-embedder`, `qdrant-rag`, `hana-vector-rag`, `pg-vector-rag`, default `OllamaRag`):
- Remove the static `import { ... } from '@mcp-abap-adt/<provider>'`.
- Replace the in-function provider lookup with dynamic `import()` wrapped in `try/catch`. On `ERR_MODULE_NOT_FOUND` or similar, throw `new MissingProviderError(packageName, factoryName)`.

Pattern to follow (already used in current `rag-factories.ts:50` for non-default backends):
```ts
async function loadOllamaRag() {
  try {
    const mod = await import('@mcp-abap-adt/ollama-embedder');
    return mod.OllamaRag;
  } catch (err) {
    throw new MissingProviderError('@mcp-abap-adt/ollama-embedder', 'ollama');
  }
}
```

b) Convert `makeRag` signature: `export async function makeRag(cfg: RagResolutionConfig, options?: RagResolutionOptions): Promise<IRag>`.

c) Convert `resolveEmbedder` signature: `export async function resolveEmbedder(cfg: EmbedderResolutionConfig, options?: EmbedderResolutionOptions): Promise<IEmbedder>`.

d) Extract the prefetch-cached lookup body into a new sync helper if it isn't already separated. Inspect existing code:

```bash
grep -n "prefetchEmbedderFactories\|registry\|cache" packages/llm-agent-rag/src/embedder-factories.ts
```

If `resolveEmbedder` already had a "look in cache" branch, lift it into `export function resolvePrefetchedEmbedder(name: string, opts: EmbedderFactoryOpts): IEmbedder`. Same for RAG: `export function resolvePrefetchedRag(name: string, opts: RagFactoryOpts): IRag`. Top-level async `resolveEmbedder()` / `makeRag()` can call `resolvePrefetchedEmbedder()` / `resolvePrefetchedRag()` after the dynamic import.

- [ ] **Step 4: Populate `packages/llm-agent-rag/src/index.ts`**

```ts
export {
  resolveEmbedder,
  resolvePrefetchedEmbedder,
  builtInEmbedderFactories,
  prefetchEmbedderFactories,
  type EmbedderFactoryOpts,
  type EmbedderResolutionConfig,
  type EmbedderResolutionOptions,
} from './embedder-factories.js';

export {
  makeRag,
  resolvePrefetchedRag,
  prefetchRagFactories,
  type RagResolutionConfig,
  type RagResolutionOptions,
} from './rag-factories.js';
```

Adjust to actual exported names (verify by reading the moved files; for example `prefetchRagFactories` may not exist yet — only export what's defined).

- [ ] **Step 5: Move related tests**

```bash
git mv packages/llm-agent-server/src/smart-agent/__tests__/embedder-factories.test.ts packages/llm-agent-rag/src/__tests__/embedder-factories.test.ts
```

Search for any test importing `rag-factories` or `makeRag`:
```bash
grep -l "from '\\.\\./rag-factories\\|from '\\.\\./\\.\\./rag-factories" packages/llm-agent-server/src/smart-agent/__tests__/
```
Move each match to `packages/llm-agent-rag/src/__tests__/`.

For each moved test:
- Rewrite relative imports of moved code to use the local path inside `llm-agent-rag` (e.g. `from '../rag-factories.js'`).
- Rewrite imports of types from `llm-agent-server` interfaces to `from '@mcp-abap-adt/llm-agent'`.
- If the test calls `makeRag` or `resolveEmbedder` synchronously, add `await`.

Add `test` script to `packages/llm-agent-rag/package.json`:
```json
"test": "node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'"
```

- [ ] **Step 6: Update server callers**

Inside `llm-agent-server` (especially `smart-agent/builder.ts`, `smart-agent/agent.ts`, `smart-agent/smart-server.ts`, `smart-agent/check-models-cli.ts`):

- Replace `import { makeRag, resolveEmbedder, ... } from './rag-factories.js'` (or relative) → `import { makeRag, resolveEmbedder } from '@mcp-abap-adt/llm-agent-rag';`
- Add `await` to every `makeRag(...)` and `resolveEmbedder(...)` call.

Run after edits:
```bash
grep -rn "makeRag\\|resolveEmbedder" packages/llm-agent-server/src/ | grep -v "@mcp-abap-adt/llm-agent-rag"
```
Each remaining match must be either an `await` call site or a string literal — anything else is a leftover sync invocation to fix.

- [ ] **Step 7: Add `@mcp-abap-adt/llm-agent-rag` to server deps**

Open `packages/llm-agent-server/package.json`, add to `dependencies`:
```json
"@mcp-abap-adt/llm-agent-rag": "*"
```

Add `{ "path": "../llm-agent-rag" }` to references in `packages/llm-agent-server/tsconfig.json`.

- [ ] **Step 8: Install + build + tests**

```bash
npm install
npx tsc -b
npm run test --workspace @mcp-abap-adt/llm-agent-rag
npm run test --workspace @mcp-abap-adt/llm-agent-server
```

Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(llm-agent-rag): move embedder/RAG factories, convert makeRag/resolveEmbedder to async"
```

---

## Task 8: Move core composition into `@mcp-abap-adt/llm-agent-libs`, convert LLM factories to async

**Goal:** Migrate everything else under `smart-agent/**` (except `cli.ts`, `server.ts`, `smart-server.ts`, `check-models-cli.ts`) into `llm-agent-libs`. Convert `makeLlm()` / `makeDefaultLlm()` to async dynamic-import. Reconcile duplicate `AgentCallOptions`.

**Files:**
- Move (entire dirs unless noted): `adapters` (sans mcp-client-adapter), `agent.ts`, `builder.ts`, `classifier`, `config`, `context`, `health`, `history`, `logger`, `metrics`, `otel`, `pipeline`, `plugins`, `policy`, `providers.ts`, `reranker`, `resilience`, `session`, `skills`, `testing`, `tracer`, `utils`, `validator` → `packages/llm-agent-libs/src/`
- Move tests under `__tests__/` (the ones not yet moved in Task 6/7).
- Modify: `packages/llm-agent-libs/src/index.ts`, `src/testing/index.ts`, `src/otel/index.ts` — populate exports
- Modify: server entry points (`cli.ts`, `server.ts`, `smart-server.ts`, `check-models-cli.ts`, `agent.ts`, `smoke-adapters.ts`) — import from `@mcp-abap-adt/llm-agent-libs`

- [ ] **Step 1: Move source directories**

```bash
SRV=packages/llm-agent-server/src/smart-agent
LIBS=packages/llm-agent-libs/src

mkdir -p $LIBS
git mv $SRV/agent.ts          $LIBS/agent.ts
git mv $SRV/builder.ts        $LIBS/builder.ts
git mv $SRV/providers.ts      $LIBS/providers.ts
git mv $SRV/adapters          $LIBS/adapters
git mv $SRV/classifier        $LIBS/classifier
git mv $SRV/config            $LIBS/config
git mv $SRV/context           $LIBS/context
git mv $SRV/health            $LIBS/health
git mv $SRV/history           $LIBS/history
git mv $SRV/logger            $LIBS/logger
git mv $SRV/metrics           $LIBS/metrics
git mv $SRV/pipeline          $LIBS/pipeline
git mv $SRV/plugins           $LIBS/plugins
git mv $SRV/policy            $LIBS/policy
git mv $SRV/reranker          $LIBS/reranker
git mv $SRV/resilience        $LIBS/resilience
git mv $SRV/session           $LIBS/session
git mv $SRV/skills            $LIBS/skills
git mv $SRV/tracer            $LIBS/tracer
git mv $SRV/utils             $LIBS/utils
git mv $SRV/validator         $LIBS/validator
git mv $SRV/otel              $LIBS/otel
git mv $SRV/testing           $LIBS/testing
```

After this, `packages/llm-agent-server/src/smart-agent/` should contain only: `cli.ts`, `server.ts`, `smart-server.ts`, `check-models-cli.ts`, `__tests__/` (some), `interfaces/` (now empty if all interface files were moved in Task 5 — delete the dir if empty).

- [ ] **Step 2: Reconcile `AgentCallOptions` duplicate**

The server's `LlmAdapter` defined a local `AgentCallOptions`. The canonical one is in `packages/llm-agent/src/interfaces/agent-contracts.ts`.

In `packages/llm-agent-libs/src/adapters/llm-adapter.ts` (now moved):
- Delete the local `AgentCallOptions` declaration.
- Add `import type { AgentCallOptions } from '@mcp-abap-adt/llm-agent';`
- If the deleted local type had additional properties beyond the canonical version, extend the canonical type in `packages/llm-agent/src/interfaces/agent-contracts.ts` to include them — DO NOT keep two divergent types.

- [ ] **Step 3: Rename internal `LlmProviderConfig` to `MakeLlmConfig`**

In `packages/llm-agent-libs/src/providers.ts`:
- Rename the lowercase `LlmProviderConfig` to `MakeLlmConfig` everywhere in this file.
- Update any imports inside `llm-agent-libs` that reference it.
- Export `MakeLlmConfig` from `packages/llm-agent-libs/src/index.ts`.

This eliminates the naming collision with the canonical `LLMProviderConfig` (uppercase) in `@mcp-abap-adt/llm-agent`.

- [ ] **Step 4: Convert `makeLlm` and `makeDefaultLlm` to async dynamic-import**

In `packages/llm-agent-libs/src/providers.ts`:

a) Remove static imports of provider classes (`OpenAIProvider`, `AnthropicProvider`, `DeepSeekProvider`, `SapAiCoreProvider`).

b) Add per-provider async loaders:
```ts
async function loadProvider(kind: 'openai' | 'anthropic' | 'deepseek' | 'sap-ai-core') {
  const map = {
    'openai':      ['@mcp-abap-adt/openai-llm', 'OpenAIProvider'],
    'anthropic':   ['@mcp-abap-adt/anthropic-llm', 'AnthropicProvider'],
    'deepseek':    ['@mcp-abap-adt/deepseek-llm', 'DeepSeekProvider'],
    'sap-ai-core': ['@mcp-abap-adt/sap-aicore-llm', 'SapAiCoreProvider'],
  } as const;
  const [pkg, exportName] = map[kind];
  try {
    const mod: Record<string, unknown> = await import(pkg);
    const Cls = mod[exportName] as new (...args: unknown[]) => unknown;
    if (typeof Cls !== 'function') throw new Error(`${exportName} not a constructor`);
    return Cls;
  } catch (err) {
    throw new MissingProviderError(pkg, kind);
  }
}
```

c) Convert signatures:
- `export async function makeLlm(cfg: MakeLlmConfig, temperature: number): Promise<ILlm>`
- `export async function makeDefaultLlm(...): Promise<ILlm>` (find current signature in the moved file; mirror)

d) Inside, replace `new OpenAIProvider(...)` with `const Provider = await loadProvider('openai'); return new Provider(...) as ILlm;`. Repeat per kind.

e) Import `MissingProviderError`:
```ts
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';
```

- [ ] **Step 5: Update internal callsites of moved code**

Inside `packages/llm-agent-libs/src/`:
- Files now use cross-package imports. Run:
  ```bash
  grep -rn "from '\\(\\.\\./\\)*\\(smart-agent/\\)\\?\\(rag-factories\\|embedder-factories\\|mcp/client\\|smart-agent/strategies\\|smart-agent/adapters/mcp-client-adapter\\)" packages/llm-agent-libs/src/
  ```
- Replace each match:
  - rag-factories / embedder-factories → `from '@mcp-abap-adt/llm-agent-rag'`
  - mcp/client / mcp-client-adapter / strategies → `from '@mcp-abap-adt/llm-agent-mcp'`
- Inter-libs imports: rewrite from now-broken `'../smart-agent/<dir>/...'` paths to local `'../<dir>/<file>.js'`.

- [ ] **Step 6: Add `await` at internal `makeLlm` / `makeDefaultLlm` callsites**

Search:
```bash
grep -rn "makeLlm(\\|makeDefaultLlm(" packages/llm-agent-libs/src/ packages/llm-agent-server/src/
```

For each callsite that is not already inside an `await` expression, add `await` (only inside async functions — `SmartAgentBuilder.build()` and similar; failing TS will indicate non-async contexts that need fixing).

- [ ] **Step 7: Move tests**

```bash
mkdir -p packages/llm-agent-libs/src/__tests__
SRV_T=packages/llm-agent-server/src/smart-agent/__tests__
LIBS_T=packages/llm-agent-libs/src/__tests__
git mv $SRV_T/smart-agent-custom-rag.test.ts          $LIBS_T/
git mv $SRV_T/request-logger.test.ts                  $LIBS_T/
git mv $SRV_T/hana-pg-integration.test.ts             $LIBS_T/
git mv $SRV_T/tool-reselection.test.ts                $LIBS_T/
git mv $SRV_T/issue-92-repro.test.ts                  $LIBS_T/
git mv $SRV_T/external-tool-propagation.test.ts       $LIBS_T/
git mv $SRV_T/smart-agent-close-session.test.ts       $LIBS_T/
git mv $SRV_T/streaming.test.ts                       $LIBS_T/
git mv $SRV_T/handle-hotswap.test.ts                  $LIBS_T/
git mv $SRV_T/regression.test.ts                      $LIBS_T/
git mv $SRV_T/config-endpoints.test.ts                $LIBS_T/
git mv $SRV_T/smart-server-api-adapters.test.ts       $LIBS_T/
```

Server should retain only test files relevant to CLI / HTTP server / legacy `Agent`:
- `server.test.ts`

Verify: `ls packages/llm-agent-server/src/smart-agent/__tests__/` should show `server.test.ts` (and possibly nothing else). Anything else not listed above — categorise and move.

For each moved test, rewrite relative cross-dir imports following the same pattern as Task 6/7. Run:
```bash
grep -rn "from '\\.\\./[^']*'" packages/llm-agent-libs/src/__tests__/ | grep -v "from '\\.\\./[a-z]*\\.js'"
```
Anything still pointing at server-relative paths needs rewriting.

Add `test` script to `packages/llm-agent-libs/package.json`:
```json
"test": "node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'"
```

- [ ] **Step 8: Populate `packages/llm-agent-libs/src/index.ts`**

Mirror the runtime composition surface from current `llm-agent-server/src/index.ts@12.0.0` MINUS:
- Symbols moved to `llm-agent-mcp` (`MCPClientWrapper`, `MCPClientConfig`, `TransportType`, `McpClientAdapter`, `createDefaultMcpClient`, `LazyConnectionStrategy`, `PeriodicConnectionStrategy`, `NoopConnectionStrategy`).
- Symbols moved to `llm-agent-rag` (`makeRag`, `resolveEmbedder`, `builtInEmbedderFactories`, `prefetchEmbedderFactories`, related types).
- Symbols already in `llm-agent` (`BaseLLMProvider`, `LLMProvider`, etc.)

Concrete content (verify against the actual files for any naming surprises):

```ts
// Builder + agent
export {
  SmartAgentBuilder,
  type SmartAgentBuilderConfig,
  type SmartAgentHandle,
  type BuilderMcpConfig,
  type BuilderPromptsConfig,
} from './builder.js';
export type {
  SmartAgentRagStores,
  SmartAgentReconfigureOptions,
} from './agent.js';

// Adapters
export {
  type AgentCallOptions, // canonical from @mcp-abap-adt/llm-agent — re-export for ergonomics
  type BaseAgentLlmBridge,
  LlmAdapter,
  type LlmAdapterProviderInfo,
} from './adapters/llm-adapter.js';
export { LlmProviderBridge } from './adapters/llm-provider-bridge.js';

// Providers (LLM)
export {
  DefaultModelResolver,
  makeDefaultLlm,
  makeLlm,
  type MakeLlmConfig,
} from './providers.js';

// Config
export {
  ConfigWatcher,
  type ConfigWatcherOptions,
  type HotReloadableConfig,
} from './config/config-watcher.js';

// Health
export {
  HealthChecker,
  type HealthCheckerDeps,
} from './health/health-checker.js';

// History
export { HistoryMemory } from './history/history-memory.js';
export { HistorySummarizer } from './history/history-summarizer.js';

// Logger
export { DefaultRequestLogger } from './logger/default-request-logger.js';
export { NoopRequestLogger } from './logger/noop-request-logger.js';

// Metrics
export {
  type CounterSnapshot,
  type HistogramSnapshot,
  InMemoryMetrics,
  type MetricsSnapshot,
} from './metrics/in-memory-metrics.js';
export { NoopMetrics } from './metrics/noop-metrics.js';

// Pipeline
export {
  buildDefaultHandlerRegistry,
  DefaultPipeline,
  evaluateCondition,
  PipelineExecutor,
} from './pipeline/index.js';

// Plugins
export {
  emptyLoadedPlugins,
  FileSystemPluginLoader,
  type FileSystemPluginLoaderConfig,
  getDefaultPluginDirs,
  loadPlugins,
  mergePluginExports,
} from './plugins/index.js';

// Reranker
export { LlmReranker } from './reranker/llm-reranker.js';
export { NoopReranker } from './reranker/noop-reranker.js';

// Resilience
export { RateLimiterLlm } from './resilience/rate-limiter-llm.js';
export {
  RetryLlm,
  type RetryOptions,
} from './resilience/retry-llm.js';
export {
  type TokenBucketConfig,
  TokenBucketRateLimiter,
} from './resilience/token-bucket-rate-limiter.js';

// Session
export { NoopSessionManager } from './session/noop-session-manager.js';
export { SessionManager } from './session/session-manager.js';

// Skills
export {
  ClaudeSkillManager,
  CodexSkillManager,
  FileSystemSkillManager,
} from './skills/index.js';

// Tracer
export { NoopTracer } from './tracer/noop-tracer.js';

// Utils
export {
  LazyInitError,
  type LazyOptions,
  lazy,
} from './utils/lazy.js';

// Validator
export { NoopValidator } from './validator/noop-validator.js';
```

Adjust filenames if needed (verify each `from './...js'` against the moved files).

Also populate:
- `packages/llm-agent-libs/src/testing/index.ts`:
  ```ts
  export * from '../testing/index.js';
  ```
  Actually `src/testing/` is now both the moved dir AND the subpath entry — confirm directory layout: after the move, files live at `packages/llm-agent-libs/src/testing/<files>`. The subpath entry `./testing` resolves to `dist/testing/index.js`. So the source `src/testing/index.ts` IS the subpath barrel — keep it as the moved file, no separate barrel needed. Delete the placeholder created in Task 4 if it conflicts.

- `packages/llm-agent-libs/src/otel/index.ts`:
  Same logic — the moved `src/otel/index.ts` is the subpath barrel.

- [ ] **Step 9: Update server entry points**

Files to edit: `packages/llm-agent-server/src/agent.ts`, `src/smoke-adapters.ts`, `src/smart-agent/cli.ts`, `src/smart-agent/server.ts`, `src/smart-agent/smart-server.ts`, `src/smart-agent/check-models-cli.ts`.

In each file, rewrite imports:
- Anything that pointed inside `smart-agent/<dir>/...` (now moved) → `from '@mcp-abap-adt/llm-agent-libs'`.
- Anything from MCP-moved code → `from '@mcp-abap-adt/llm-agent-mcp'`.
- Anything from RAG-moved code → `from '@mcp-abap-adt/llm-agent-rag'`.

Run as a sanity check:
```bash
grep -rn "from '\\.\\./" packages/llm-agent-server/src/ | head -40
```
Each remaining relative import must point to a file still inside server (e.g. `'../agent.js'` from CLI to legacy `Agent`); anything pointing at moved code is a leftover.

- [ ] **Step 10: Add deps to server `package.json`**

In `packages/llm-agent-server/package.json`:
```json
"dependencies": {
  "@mcp-abap-adt/llm-agent": "*",
  "@mcp-abap-adt/llm-agent-mcp": "*",
  "@mcp-abap-adt/llm-agent-rag": "*",
  "@mcp-abap-adt/llm-agent-libs": "*",
  "@modelcontextprotocol/sdk": "^1.28.0",
  "dotenv": "^17.3.1",
  "yaml": "^2.8.3",
  "zod": "^4.3.6"
}
```

Strip any deps that are no longer directly used (e.g. removed in Task 6/7). Keep optional peer providers as before — the binary needs them at runtime.

Add `{ "path": "../llm-agent-libs" }` to references in `packages/llm-agent-server/tsconfig.json`.

- [ ] **Step 11: Install + build + tests**

```bash
npm install
npx tsc -b
npm run test --workspace @mcp-abap-adt/llm-agent-libs
npm run test --workspace @mcp-abap-adt/llm-agent-server
```

Expected: clean. If a test fails because a previously sync `makeLlm`/`makeRag` call now needs `await`, fix and re-run.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor(llm-agent-libs): move core composition, async makeLlm, rename internal LlmProviderConfig"
```

---

## Task 9: Trim `@mcp-abap-adt/llm-agent-server` to binary-only

**Goal:** Remove all library exports from `llm-agent-server`. Package publishes only the CLI binary.

**Files:**
- Modify: `packages/llm-agent-server/src/index.ts` — trim to `export {}` or delete
- Modify: `packages/llm-agent-server/package.json` — remove `main`/`types`/`exports`, keep `bin`
- Modify: `packages/llm-agent-server/tsconfig.json` — `outDir` setting unchanged but verify build still produces binaries

- [ ] **Step 1: Replace `packages/llm-agent-server/src/index.ts` with stub**

```ts
// llm-agent-server is a binary-only package. Library imports are not supported.
// For SmartAgent composition, depend on @mcp-abap-adt/llm-agent-libs.
export {};
```

- [ ] **Step 2: Update `packages/llm-agent-server/package.json`**

- Remove keys: `"main"`, `"types"`.
- Replace `"exports"` with:
  ```json
  "exports": {
    "./package.json": "./package.json"
  }
  ```
- Keep `"bin"` unchanged.
- Confirm `"files"` still includes `dist` (binary entry points need to be published).

- [ ] **Step 3: Verify directory cleanup**

```bash
ls packages/llm-agent-server/src/smart-agent/
```
Expected files: `cli.ts`, `server.ts`, `smart-server.ts`, `check-models-cli.ts`, `__tests__/server.test.ts`. Delete any empty subdirectories left over (e.g. `interfaces/` if empty after Task 5):
```bash
find packages/llm-agent-server/src -type d -empty -delete
```

- [ ] **Step 4: Build + smoke tests**

```bash
npm install
npx tsc -b
npm run test --workspace @mcp-abap-adt/llm-agent-server
```

Smoke tests (manual; run from repo root):
```bash
npm run dev:llm
# wait a few seconds, observe startup, Ctrl+C
npm run dev
# same; this requires MCP server reachable per .env — Ctrl+C if it tries to connect somewhere unavailable
```

Expected: both binaries start without import-resolution errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(llm-agent-server)!: remove library exports, package is binary-only"
```

---

## Task 10: Update `docs/ARCHITECTURE.md` and per-package READMEs

**Goal:** Document the new five-package layout, migration paths, and the layered RAG API (top-level async vs sync prefetched helpers).

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `packages/llm-agent/README.md`
- Modify: `packages/llm-agent-server/README.md`
- Modify: `packages/llm-agent-mcp/README.md` (created in Task 2 — expand)
- Modify: `packages/llm-agent-rag/README.md` (created in Task 3 — expand)
- Modify: `packages/llm-agent-libs/README.md` (created in Task 4 — expand)
- Modify: `CLAUDE.md` if its package layout section is out of date

- [ ] **Step 1: Update `docs/ARCHITECTURE.md`**

Replace the package-layout section with the layout from the spec (see "Final package layout" in `docs/superpowers/specs/2026-04-28-llm-agent-libs-split-design.md`). Include the dependency graph diagram.

- [ ] **Step 2: Add migration table to `packages/llm-agent/README.md`**

Append a section "Migration from 12.0.0":

```markdown
## Migration from 12.0.0

Symbols that briefly appeared only in `@mcp-abap-adt/llm-agent-server@12.0.0` are now in their dedicated packages:

| Symbol | Was (12.0.0) | Now (12.0.1) |
|---|---|---|
| `MCPClientWrapper`, `McpClientAdapter`, `LazyConnectionStrategy`, ... | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/llm-agent-mcp` |
| `makeRag`, `resolveEmbedder`, `prefetchEmbedderFactories`, ... | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/llm-agent-rag` |
| `SmartAgentBuilder`, `SessionManager`, `makeLlm`, `InMemoryMetrics`, ... | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/llm-agent-libs` |
| Interfaces (`IMetrics`, `ITracer`, `ISessionManager`, `IPluginLoader`, ...) | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/llm-agent` |

`makeLlm`, `makeRag`, and `resolveEmbedder` are now **async** (`Promise<ILlm>` / `Promise<IRag>` / `Promise<IEmbedder>`). Direct callers add one `await`. Consumers using `SmartAgentBuilder` only are unaffected.
```

- [ ] **Step 3: Expand `packages/llm-agent-mcp/README.md`**

```markdown
# @mcp-abap-adt/llm-agent-mcp

MCP client wrapper, adapter, factory, and connection strategies.

## Exports

- `MCPClientWrapper`, `MCPClientConfig`, `TransportType`
- `McpClientAdapter`
- `createDefaultMcpClient()`
- `LazyConnectionStrategy`, `PeriodicConnectionStrategy`, `NoopConnectionStrategy`

## Usage

```ts
import { MCPClientWrapper, McpClientAdapter } from '@mcp-abap-adt/llm-agent-mcp';

const client = new MCPClientWrapper({ transport: 'stream-http', url: '...' });
await client.connect();
const adapter = new McpClientAdapter(client);
```

See `docs/ARCHITECTURE.md` for the full SmartAgent layout.
```

- [ ] **Step 4: Expand `packages/llm-agent-rag/README.md`**

```markdown
# @mcp-abap-adt/llm-agent-rag

RAG / embedder composition.

## Exports

- `makeRag(cfg, options)` — async, dynamic-imports the configured backend.
- `resolveEmbedder(cfg, options)` — async, dynamic-imports the configured embedder.
- `prefetchEmbedderFactories()` / `prefetchRagFactories()` — optional warm-up.
- `resolvePrefetchedEmbedder(name, opts)` / `resolvePrefetchedRag(name, opts)` — synchronous after prefetch.

## Two patterns

### Common case (dynamic-import each call)

```ts
import { makeRag } from '@mcp-abap-adt/llm-agent-rag';
const rag = await makeRag({ backend: 'qdrant', url: '...' }, { embedder, breaker });
```

### Hot-path consumers (prefetch once, sync resolve)

```ts
import { prefetchEmbedderFactories, prefetchRagFactories, resolvePrefetchedRag } from '@mcp-abap-adt/llm-agent-rag';

await prefetchEmbedderFactories();
await prefetchRagFactories();

// Inside hot loop:
const rag = resolvePrefetchedRag('qdrant', { embedder, breaker });
```

## Optional peer dependencies

Install only the backends you use:

- `@mcp-abap-adt/openai-embedder`
- `@mcp-abap-adt/ollama-embedder`
- `@mcp-abap-adt/sap-aicore-embedder`
- `@mcp-abap-adt/qdrant-rag`
- `@mcp-abap-adt/hana-vector-rag`
- `@mcp-abap-adt/pg-vector-rag`

Missing backends throw `MissingProviderError` from `@mcp-abap-adt/llm-agent` at first use.
```

- [ ] **Step 5: Expand `packages/llm-agent-libs/README.md`**

```markdown
# @mcp-abap-adt/llm-agent-libs

Core SmartAgent composition runtime.

## Exports (top-level)

`SmartAgentBuilder`, `SessionManager`, `HistoryMemory`, `HistorySummarizer`, `DefaultPipeline`, `PipelineExecutor`, `buildDefaultHandlerRegistry`, `HealthChecker`, `ConfigWatcher`, `FileSystemPluginLoader`, `Claude/Codex/FileSystem` skill managers, `RetryLlm`, `RateLimiterLlm`, `TokenBucketRateLimiter`, `LlmReranker`, `NoopReranker`, `InMemoryMetrics`, `NoopMetrics`, `NoopTracer`, `NoopValidator`, `LlmAdapter`, `LlmProviderBridge`, `makeLlm`, `makeDefaultLlm`, `DefaultModelResolver`, `lazy`, `LazyInitError`. Plus their public type companions.

## Subpath exports

- `@mcp-abap-adt/llm-agent-libs/testing` — test helpers.
- `@mcp-abap-adt/llm-agent-libs/otel` — OpenTelemetry tracer adapter.

## Optional peer dependencies (LLM providers)

- `@mcp-abap-adt/openai-llm`
- `@mcp-abap-adt/anthropic-llm`
- `@mcp-abap-adt/deepseek-llm`
- `@mcp-abap-adt/sap-aicore-llm`

Install only the providers you use. Missing providers throw `MissingProviderError` at first call to `makeLlm`.

## Migration from 12.0.0

```ts
// Before
import { SmartAgentBuilder, SessionManager, makeLlm } from '@mcp-abap-adt/llm-agent-server';

// After
import { SmartAgentBuilder, SessionManager, makeLlm } from '@mcp-abap-adt/llm-agent-libs';

// makeLlm is now async — add await at direct callsites
const llm = await makeLlm(cfg, temperature);
```

`SmartAgentBuilder.build()` is already async; users of the builder are unaffected by the `makeLlm` async conversion.
```

- [ ] **Step 6: Update `packages/llm-agent-server/README.md`**

State that the package is binary-only:

```markdown
# @mcp-abap-adt/llm-agent-server

Runnable distribution of SmartAgent (CLI + HTTP server). Binary-only.

## Library imports are not supported

Importing from `@mcp-abap-adt/llm-agent-server` as a library is not supported as of 12.0.1. For SmartAgent composition use `@mcp-abap-adt/llm-agent-libs`. For interfaces and DTOs use `@mcp-abap-adt/llm-agent`. For MCP-only use cases use `@mcp-abap-adt/llm-agent-mcp`. For RAG-only use cases use `@mcp-abap-adt/llm-agent-rag`.

## Binaries

(... existing binary docs ...)
```

- [ ] **Step 7: Sync `CLAUDE.md` package layout**

If `CLAUDE.md` lists the package layout, refresh it to match `docs/ARCHITECTURE.md`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs: document the four-package SmartAgent layout and migration paths"
```

---

## Task 11: Add changeset entry and validate version bump

**Goal:** Add a `patch` changeset that bumps the family to 12.0.1.

**Files:**
- Create: `.changeset/<auto-name>.md`

- [ ] **Step 1: Create the changeset**

Run: `npx changeset`

In the interactive prompt:
- Select the five family packages (`llm-agent`, `llm-agent-mcp`, `llm-agent-rag`, `llm-agent-libs`, `llm-agent-server`).
- Choose `patch`.
- Summary: `Complete the v12 package split: introduce llm-agent-mcp, llm-agent-rag, llm-agent-libs; convert top-level LLM/RAG factories to async dynamic-import; llm-agent-server is now binary-only. Closes #125.`

This produces a file like `.changeset/<adjective>-<noun>-<random>.md`.

- [ ] **Step 2: Verify**

```bash
npx changeset status
```
Expected: lists the five family packages with `patch` bump.

```bash
npx changeset version --snapshot
```
Wait — DO NOT run `version --snapshot` yet, as that mutates files. Instead, mentally verify by reading the generated `.md` file: it should list all five packages.

- [ ] **Step 3: Commit**

```bash
git add .changeset/
git commit -m "chore(changeset): patch bump for v12 split completion"
```

---

## Task 12: Final verification

**Goal:** Confirm full build, lint, and binary smoke tests pass before opening the PR.

- [ ] **Step 1: Clean rebuild**

```bash
npm run clean
npm install
npm run build
```

Expected: clean build for all packages.

- [ ] **Step 2: Lint**

```bash
npm run lint
```

Expected: no errors. Biome auto-fix is allowed (`--write`); commit any auto-fixes:
```bash
git diff --quiet || git commit -am "style: biome auto-fix"
```

- [ ] **Step 3: Run all tests**

```bash
npm run test --workspaces --if-present
```

Expected: all suites pass.

- [ ] **Step 4: Binary smoke tests**

From repo root:
```bash
npm run dev:llm
```
Expected: agent starts in LLM-only mode, prompts visible, no resolution errors. Ctrl+C.

```bash
npm run dev
```
Expected: tries to connect to MCP per `.env` (or default `http://localhost:4004/mcp/stream/http`). If MCP server is not running, the agent should report a connection error, NOT an import/module-not-found error. Ctrl+C.

If a `MissingProviderError` fires for a provider that should be installed (because it's an optional peer + the test environment expects it), check whether `optional peerDependenciesMeta` is set correctly — see Task 4.

- [ ] **Step 5: Commit any smoke-test fixes**

```bash
git diff --quiet || git commit -am "fix: smoke-test follow-ups"
```

---

## Task 13: Open PR

- [ ] **Step 1: Push branch and open PR**

```bash
git push -u origin <branch-name>
gh pr create --title "Complete v12 package split (mcp + rag + libs); async LLM/RAG factories" --body "$(cat <<'EOF'
## Summary
- Split the SmartAgent runtime composition out of `llm-agent-server` into three new packages: `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`, `@mcp-abap-adt/llm-agent-libs`.
- `llm-agent-server` becomes binary-only (CLI + HTTP server) — library imports are no longer supported.
- Convert `makeLlm()` / `makeDefaultLlm()` / `makeRag()` / `resolveEmbedder()` from static imports to async dynamic-import + `MissingProviderError`. Delivers the optional-peer promise that v12 advertised.
- Move dependency-free interfaces and public DTOs into `@mcp-abap-adt/llm-agent`.
- Narrow the changesets `fixed` group to the five SmartAgent family packages so provider/embedder/RAG leaves can evolve independently.

Closes #125.

## Test plan
- [x] Workspace `tsc -b` clean
- [x] `npm run lint` clean
- [x] `npm run test --workspaces` passes
- [x] `npm run dev:llm` starts without resolution errors
- [x] `npm run dev` starts without resolution errors (MCP connection failure if no server is fine)
- [x] `cloud-llm-hub` can be migrated by changing import paths and adding `await` at one direct `makeLlm` callsite

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Verify PR**

Confirm the PR shows the changeset file and all moved files. CI must pass.

---

## Notes

- The plan does not introduce new tests. Test coverage moves with the code; new functionality (dynamic provider loading) relies on existing factory tests + manual smoke tests.
- If during execution a moved file references symbols not yet covered (e.g. some embedder factory uses an internal `cache.ts` that wasn't in the move list), include it in the relevant move task and adjust imports — do not stash the symbol elsewhere "for now".
- Per CLAUDE.md, all artifacts must be in English (already the case here). Communicate with the user in their language during the work.
- Per `feedback_commit_lockfiles.md`: always commit `package-lock.json` changes alongside the work.
- Per `feedback_rate_limit.md`: do not health-check SAP AI Core at startup after the rebuild.
