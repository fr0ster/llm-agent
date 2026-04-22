# v11.0.0 Complete Provider and Backend Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every LLM provider, every embedder, and QdrantRag into dedicated packages. Remove the non-Smart Agent hierarchy. Make server's provider dependencies optional peers with dynamic-import + `MissingProviderError` resolution. Drop all v10 back-compat re-exports. Core's runtime dep shrinks to `zod` only.

**Architecture:** In-place `git mv` into new sibling packages under `packages/`. One commit per package move (8 packages). Factory registry relocates from core to server, gains dynamic `import()` + typed missing-peer error. CLI rewritten to use `SmartAgentBuilder` as the single path.

**Tech Stack:** TypeScript strict, ESM, npm workspaces, `@changesets/cli`, Biome, Node 22, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-04-22-v11-full-extraction-design.md`
**Branch:** `feat/v11-full-extraction`

**Migration nature:** `git mv`-based file moves + import rewrites + removal of Agent classes. Tests move with their code. Three end-to-end validation tasks before tagging.

---

## File map

**New packages (8):** `packages/openai-llm/`, `packages/anthropic-llm/`, `packages/deepseek-llm/`, `packages/sap-aicore-llm/`, `packages/openai-embedder/`, `packages/ollama-embedder/`, `packages/sap-aicore-embedder/`, `packages/qdrant-rag/`.

**Moves out of core (`packages/llm-agent/src/rag/`):**
- `openai-embedder.ts` → `packages/openai-embedder/src/openai-embedder.ts`
- `sap-ai-core-embedder.ts` → `packages/sap-aicore-embedder/src/sap-ai-core-embedder.ts`
- `ollama-rag.ts` (contains `OllamaEmbedder` + `OllamaRag`) → `packages/ollama-embedder/src/ollama.ts`
- `qdrant-rag.ts` → `packages/qdrant-rag/src/qdrant-rag.ts`
- `qdrant-rag-provider.ts` (if extracted in 9.1; check for current path) → `packages/qdrant-rag/src/qdrant-rag-provider.ts`
- `embedder-factories.ts` → `packages/llm-agent-server/src/smart-agent/embedder-factories.ts`

**Moves out of server (`packages/llm-agent-server/src/llm-providers/`):**
- `openai.ts` → `packages/openai-llm/src/openai-provider.ts`
- `anthropic.ts` → `packages/anthropic-llm/src/anthropic-provider.ts`
- `deepseek.ts` → `packages/deepseek-llm/src/deepseek-provider.ts`
- `sap-core-ai.ts` → `packages/sap-aicore-llm/src/sap-core-ai-provider.ts`
- `base.ts` (`BaseLLMProvider`) → moves to `packages/llm-agent/src/llm/base-llm-provider.ts`. Task 2 verifies it has no server-only deps (types-from-core only) and performs the `git mv`. Fallback: if inspection shows server-only imports, Task 2 falls back to duplicating the class locally inside each LLM package instead.

**Deletions:**
- `packages/llm-agent-server/src/agents/` (entire directory — BaseAgent, OpenAIAgent, AnthropicAgent, DeepSeekAgent, SapCoreAIAgent, PromptBasedAgent, index.ts, __tests__). Removed after CLI refactor.

**Rewritten:**
- `packages/llm-agent-server/src/smart-agent/cli.ts` — single path via SmartAgentBuilder, `mcp.type: 'none'` for LLM-only mode.
- `packages/llm-agent-server/src/smart-agent/providers.ts` — constructs `ILlm` directly from provider classes, no Agent wrapping.
- `packages/llm-agent-server/src/smoke-adapters.ts` — adapted to new provider path.

**Kept in core:** `InMemoryRag`, `VectorRag`, registry, strategies, corrections, overlays, wrappers, MCP tool factory, inverted-index, query-embedding, query-expander, preprocessor, search-strategy, tool-indexing-strategy.

---

## Task 1: Root build script + tsconfig references

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update root `package.json` scripts**

Replace the existing `build`/`clean`:

```json
{
  "scripts": {
    "prebuild": "npm run --workspace @mcp-abap-adt/llm-agent-server prebuild",
    "build": "tsc -b packages/llm-agent packages/openai-llm packages/anthropic-llm packages/openai-embedder packages/ollama-embedder packages/sap-aicore-llm packages/sap-aicore-embedder packages/qdrant-rag packages/deepseek-llm packages/llm-agent-server",
    "clean": "tsc -b --clean packages/llm-agent packages/openai-llm packages/anthropic-llm packages/openai-embedder packages/ollama-embedder packages/sap-aicore-llm packages/sap-aicore-embedder packages/qdrant-rag packages/deepseek-llm packages/llm-agent-server"
  }
}
```

Order: core first, then packages depending only on core (openai-llm, anthropic-llm, 3 embedders, qdrant-rag), then deepseek-llm (depends on openai-llm), then server (depends on all).

- [ ] **Step 2: Verify build still works with old structure**

```
npm run build 2>&1 | tail -5
```

Will fail because `packages/openai-llm` etc. don't exist yet. That's expected — this task only prepares the build definition. Tasks 2-9 add the packages.

- [ ] **Step 3: Commit**

```
git add package.json
git commit -m "chore(monorepo): extend build/clean scripts for v11 extraction targets

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Create `@mcp-abap-adt/openai-llm` skeleton + move `OpenAIProvider`

**Files:**
- Create: `packages/openai-llm/{package.json,tsconfig.json,README.md,src/index.ts}`
- `git mv` source: `packages/llm-agent-server/src/llm-providers/openai.ts` → `packages/openai-llm/src/openai-provider.ts`

- [ ] **Step 1: Create directory**

```
mkdir -p packages/openai-llm/src
```

- [ ] **Step 2: `packages/openai-llm/package.json`**

```json
{
  "name": "@mcp-abap-adt/openai-llm",
  "version": "11.0.0",
  "description": "OpenAI LLM provider (ILlm) for @mcp-abap-adt/llm-agent.",
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
    "@mcp-abap-adt/llm-agent": "*",
    "axios": "^1.14.0"
  },
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/fr0ster/llm-agent.git" },
  "publishConfig": { "access": "public" }
}
```

- [ ] **Step 3: `packages/openai-llm/tsconfig.json`**

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

- [ ] **Step 4: `packages/openai-llm/README.md`**

```markdown
# @mcp-abap-adt/openai-llm

OpenAI LLM provider for `@mcp-abap-adt/llm-agent` / `@mcp-abap-adt/llm-agent-server`.

Exports:
- `OpenAIProvider` — implements `ILlm`, calls OpenAI `/v1/chat/completions` and `/v1/completions`.
- `OpenAIConfig` — configuration type.

This package is an optional peer dependency of `@mcp-abap-adt/llm-agent-server`. Install it when your `smart-server.yaml` names `openai` as the LLM provider, or when constructing an `OpenAIProvider` programmatically.
```

- [ ] **Step 5: Move the source file**

```
git mv packages/llm-agent-server/src/llm-providers/openai.ts packages/openai-llm/src/openai-provider.ts
```

If the file has co-located tests under `packages/llm-agent-server/src/llm-providers/__tests__/openai.test.ts`, move that too:

```
mkdir -p packages/openai-llm/src/__tests__
git mv packages/llm-agent-server/src/llm-providers/__tests__/openai.test.ts packages/openai-llm/src/__tests__/openai-provider.test.ts
```

- [ ] **Step 6: Write `packages/openai-llm/src/index.ts`**

```ts
export { OpenAIProvider, type OpenAIConfig } from './openai-provider.js';
```

- [ ] **Step 7: Fix imports inside the moved file**

`openai-provider.ts` currently imports from `../../interfaces/...`, `../../types.js`, `../base.js`, etc. Rewrite:
- `from '../../interfaces/...'` → `from '@mcp-abap-adt/llm-agent'`
- `from '../../types.js'` → `from '@mcp-abap-adt/llm-agent'`
- `from '../base.js'` (BaseLLMProvider) → if BaseLLMProvider stays in server, this file can't depend on it from here. The moved file must become self-contained: either the BaseLLMProvider class moves to `packages/openai-llm/src/base-llm-provider.ts` as a local helper, or OpenAIProvider gets inlined. Easiest: inline base fields into OpenAIProvider — `BaseLLMProvider` is tiny (~40 lines).

If BaseLLMProvider is shared by Anthropic + DeepSeek + SAP, replicating it in four packages is wasteful. Move `BaseLLMProvider` to core (`packages/llm-agent/src/llm/base-provider.ts`) so every LLM package can re-import it. Core has no SDK deps, so BaseLLMProvider belongs there anyway.

Decision: **move `BaseLLMProvider` to core in Task 2** (now), export it, then rewrite openai-provider.ts to `from '@mcp-abap-adt/llm-agent'`.

```
git mv packages/llm-agent-server/src/llm-providers/base.ts packages/llm-agent/src/llm/base-llm-provider.ts
mkdir -p packages/llm-agent/src/llm
# adjust path if the mkdir creates after the mv; run mkdir first if so
```

Add re-export in `packages/llm-agent/src/index.ts`: `export { BaseLLMProvider } from './llm/base-llm-provider.js';`.

Rewrite `openai-provider.ts` imports: `import { BaseLLMProvider, type Message, ... } from '@mcp-abap-adt/llm-agent';`.

- [ ] **Step 8: Build core + openai-llm**

```
cd packages/llm-agent && npm exec tsc -p tsconfig.json && cd ../..
cd packages/openai-llm && npm exec tsc -p tsconfig.json && cd ../..
```

Both must exit 0.

- [ ] **Step 9: Run package tests**

```
cd packages/openai-llm && npm test 2>&1 | tail -5 && cd ../..
```

Tests that referenced relative paths into server need updating — use the same grep-and-rewrite approach as v10 (imports from `'../../../interfaces/...'` → `from '@mcp-abap-adt/llm-agent'`).

- [ ] **Step 10: Commit**

```
git add -A
git commit -m "feat(openai-llm)!: extract OpenAIProvider into @mcp-abap-adt/openai-llm

BaseLLMProvider moves to core as it's a generic abstract class consumed by
all LLM-provider packages.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Create `@mcp-abap-adt/anthropic-llm` and move `AnthropicProvider`

Follow the same pattern as Task 2 with these substitutions:

- Directory: `packages/anthropic-llm/`
- Package name: `@mcp-abap-adt/anthropic-llm`
- Description: `Anthropic (Claude) LLM provider (ILlm) for @mcp-abap-adt/llm-agent.`
- `git mv`: `packages/llm-agent-server/src/llm-providers/anthropic.ts` → `packages/anthropic-llm/src/anthropic-provider.ts`
- Co-located test: `anthropic.test.ts` → `packages/anthropic-llm/src/__tests__/anthropic-provider.test.ts` (if present)
- index: `export { AnthropicProvider, type AnthropicConfig } from './anthropic-provider.js';`
- Dependencies: `@mcp-abap-adt/llm-agent: "*"`, `axios: "^1.14.0"`
- Commit message: `feat(anthropic-llm)!: extract AnthropicProvider into @mcp-abap-adt/anthropic-llm`

All other steps (tsconfig, README, import rewrite, build, test, commit) mirror Task 2 exactly.

---

## Task 4: Create `@mcp-abap-adt/sap-aicore-llm` and move `SapCoreAIProvider`

Follow the Task 2 pattern:
- Directory: `packages/sap-aicore-llm/`
- Package name: `@mcp-abap-adt/sap-aicore-llm`
- Description: `SAP AI Core LLM provider (ILlm) for @mcp-abap-adt/llm-agent.`
- `git mv`: `packages/llm-agent-server/src/llm-providers/sap-core-ai.ts` → `packages/sap-aicore-llm/src/sap-core-ai-provider.ts`
- index: `export { SapCoreAIProvider, type SapCoreAIConfig } from './sap-core-ai-provider.js';`
- Dependencies: `@mcp-abap-adt/llm-agent: "*"`, `@sap-ai-sdk/orchestration: "^2.9.0"`. No `axios` (SAP SDK manages its own HTTP).
- Commit message: `feat(sap-aicore-llm)!: extract SapCoreAIProvider into @mcp-abap-adt/sap-aicore-llm`

---

## Task 5: Create `@mcp-abap-adt/deepseek-llm` and move `DeepSeekProvider`

Task 2 pattern with one extra step: `deepseek-llm` depends on `openai-llm` (inheritance).

- Directory: `packages/deepseek-llm/`
- Dependencies: `@mcp-abap-adt/llm-agent: "*"`, `@mcp-abap-adt/openai-llm: "*"` (workspace resolves to `*`).
- `tsconfig.json` `references`: `[{ "path": "../llm-agent" }, { "path": "../openai-llm" }]`.
- `git mv`: `deepseek.ts` → `packages/deepseek-llm/src/deepseek-provider.ts`.
- Rewrite imports: `import { OpenAIProvider } from './openai.js'` becomes `import { OpenAIProvider } from '@mcp-abap-adt/openai-llm'`.
- index: `export { DeepSeekProvider, type DeepSeekConfig } from './deepseek-provider.js';`
- Commit: `feat(deepseek-llm)!: extract DeepSeekProvider into @mcp-abap-adt/deepseek-llm`

---

## Task 6: Create `@mcp-abap-adt/openai-embedder` and move `OpenAiEmbedder`

Task 2 pattern with these specifics:
- Directory: `packages/openai-embedder/`
- Description: `OpenAI embedding provider (IEmbedderBatch) for @mcp-abap-adt/llm-agent.`
- `git mv`: `packages/llm-agent/src/rag/openai-embedder.ts` → `packages/openai-embedder/src/openai-embedder.ts`
- Co-located tests if any.
- index: `export { OpenAiEmbedder, type OpenAiEmbedderConfig } from './openai-embedder.js';`
- Dependencies: `@mcp-abap-adt/llm-agent: "*"` only. No `axios` — OpenAiEmbedder uses native `fetch`.
- Commit: `feat(openai-embedder)!: extract OpenAiEmbedder into @mcp-abap-adt/openai-embedder`

**Important:** because this file moves OUT of core, `packages/llm-agent/src/rag/index.ts` must remove its re-export of `./openai-embedder.js`. Verify that change is part of this commit.

---

## Task 7: Create `@mcp-abap-adt/ollama-embedder` and move `OllamaEmbedder` + `OllamaRag`

Task 2 pattern with these specifics:
- Directory: `packages/ollama-embedder/`
- Description: `Ollama embedding provider (IEmbedder) and OllamaRag convenience class.`
- `git mv`: `packages/llm-agent/src/rag/ollama-rag.ts` → `packages/ollama-embedder/src/ollama.ts` (this file contains both `OllamaEmbedder` and `OllamaRag`; rename once moved if needed).
- index: `export { OllamaEmbedder, OllamaRag, type OllamaEmbedderConfig } from './ollama.js';`
- Dependencies: `@mcp-abap-adt/llm-agent: "*"` only (native fetch).
- Commit: `feat(ollama-embedder)!: extract Ollama classes into @mcp-abap-adt/ollama-embedder`

Remove re-exports from core's `rag/index.ts`.

---

## Task 8: Create `@mcp-abap-adt/sap-aicore-embedder` and move `SapAiCoreEmbedder`

Task 2 pattern:
- Directory: `packages/sap-aicore-embedder/`
- `git mv`: `packages/llm-agent/src/rag/sap-ai-core-embedder.ts` → `packages/sap-aicore-embedder/src/sap-ai-core-embedder.ts`
- index: `export { SapAiCoreEmbedder, type SapAiCoreEmbedderConfig } from './sap-ai-core-embedder.js';`
- Dependencies: `@mcp-abap-adt/llm-agent: "*"`, `@sap-ai-sdk/foundation-models: "^2.0.0"` (verify actual package name in the current imports; substitute if it uses a different subpackage).
- Commit: `feat(sap-aicore-embedder)!: extract SapAiCoreEmbedder into @mcp-abap-adt/sap-aicore-embedder`

Remove re-exports from core's `rag/index.ts`.

---

## Task 9: Create `@mcp-abap-adt/qdrant-rag` and move `QdrantRag` + `QdrantRagProvider`

Task 2 pattern:
- Directory: `packages/qdrant-rag/`
- Description: `QdrantRag vector store and QdrantRagProvider for @mcp-abap-adt/llm-agent.`
- `git mv`: `packages/llm-agent/src/rag/qdrant-rag.ts` → `packages/qdrant-rag/src/qdrant-rag.ts` and (if separate) `qdrant-rag-provider.ts` → `packages/qdrant-rag/src/qdrant-rag-provider.ts`.
- index: `export { QdrantRag, QdrantRagProvider, type QdrantRagConfig, type QdrantRagProviderConfig } from './qdrant-rag.js';` (split if provider is in a separate file).
- Dependencies: `@mcp-abap-adt/llm-agent: "*"`, `axios: "^1.14.0"`.
- Commit: `feat(qdrant-rag)!: extract QdrantRag + QdrantRagProvider into @mcp-abap-adt/qdrant-rag`

Remove re-exports from core's `rag/index.ts`. Core's `package.json` drops `axios` dependency (it's still in `@sap-ai-sdk/orchestration` transitive chain if any but not in core's `dependencies`).

---

## Task 10: Delete Agent hierarchy

**Files:**
- Delete: `packages/llm-agent-server/src/agents/` (entire directory)
- Modify: `packages/llm-agent-server/src/index.ts` — drop Agent re-exports
- Modify: `packages/llm-agent-server/src/smart-agent/providers.ts` — remove Agent instantiations (done in Task 11)

- [ ] **Step 1: Identify non-test dependencies of Agent classes**

```
grep -rn "OpenAIAgent\|AnthropicAgent\|DeepSeekAgent\|SapCoreAIAgent\|PromptBasedAgent\|BaseAgent" packages/llm-agent-server/src/ | grep -v agents/ | grep -v __tests__
```

Expected: references from `smart-agent/providers.ts`, `smart-agent/cli.ts`, `smoke-adapters.ts`, `index.ts`. Note each file.

- [ ] **Step 2: Delete the directory**

```
git rm -r packages/llm-agent-server/src/agents
```

- [ ] **Step 3: Remove re-exports from server's `index.ts`**

Remove every line re-exporting `OpenAIAgent`, `AnthropicAgent`, etc.

- [ ] **Step 4: Stage other references for Task 11**

Build WILL fail at this point because `providers.ts`, `cli.ts`, `smoke-adapters.ts` still reference Agent classes. Task 11 fixes them. Don't commit yet — we commit after Task 11 ties the knot.

- [ ] **Step 5: Stash changes and proceed to Task 11**

Don't commit. Task 11 continues directly from this state.

---

## Task 11: Rewrite `cli.ts`, `providers.ts`, `smoke-adapters.ts` to use SmartAgent + LLM providers directly

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/cli.ts`
- Modify: `packages/llm-agent-server/src/smart-agent/providers.ts`
- Modify: `packages/llm-agent-server/src/smoke-adapters.ts`
- Modify: `packages/llm-agent-server/src/index.ts` — drop any remaining Agent-related exports

- [ ] **Step 1: Inspect current `providers.ts` to understand its shape**

```
cat packages/llm-agent-server/src/smart-agent/providers.ts | head -80
```

The current file builds concrete `ILlm` by constructing an Agent (e.g. `new DeepSeekAgent({...})`) and wrapping in `LlmAdapter`. New shape: import the provider class directly from its package (`@mcp-abap-adt/deepseek-llm`), construct it, return the `ILlm`.

- [ ] **Step 2: Rewrite `providers.ts`**

Template for each provider branch (example for DeepSeek):

```ts
import { DeepSeekProvider } from '@mcp-abap-adt/deepseek-llm';
import type { ILlm } from '@mcp-abap-adt/llm-agent';

// Replace:
//   const agent = new DeepSeekAgent({...});
//   llm = new LlmAdapter(agent, {...});
// With:
llm = new DeepSeekProvider({
  apiKey: ...,
  model: ...,
  // other config fields that the old Agent took
});
```

Repeat for `OpenAIProvider`, `AnthropicProvider`, `SapCoreAIProvider`. Remove any `PromptBasedAgent` branch (that was an LLM-only synthetic agent; it's gone).

- [ ] **Step 3: Rewrite `cli.ts`**

The existing `cli.ts` has two modes: MCP-enabled (uses SmartAgent) and LLM-only (uses Agent classes). Collapse to a single `SmartAgentBuilder` path using the **actual** builder API (`withXxx`, `setXxx`, no invented methods):

```ts
import { SmartAgentBuilder } from './builder.js';

// llm is an ILlm built via providers.ts path (concrete provider instance)
const builder = new SmartAgentBuilder().withMainLlm(llm);

// MCP wiring: if config.mcp.type === 'none', skip withMcpClients entirely.
// Otherwise construct MCP clients per config and inject.
if (config.mcp.type !== 'none') {
  const mcpClients = await constructMcpClientsFromConfig(config.mcp);
  builder.withMcpClients(mcpClients);
}

// Other existing config flows (tools RAG, history RAG, classifier, helper LLM, etc.)
// use their pre-existing builder methods — preserve them as-is.

const agent = await builder.build();
```

Key: `mcp.type === 'none'` → `withMcpClients` NOT called; the agent composes without MCP. `SmartAgentBuilder` itself never sees `'none'` — the config-resolution layer gates the call. This preserves the existing contract per spec.

Do NOT invent builder methods like `setMcp`. Use only methods that exist in `packages/llm-agent-server/src/smart-agent/builder.ts` today — grep the file to confirm the signature before each call in the rewrite.

- [ ] **Step 4: Rewrite `smoke-adapters.ts`**

Remove any `new OpenAIAgent(...)` constructions. Build an `ILlm` directly from a provider class, exercise the smoke path.

- [ ] **Step 5: Delete `LlmAdapter` if only used by Agent wrapping**

```
grep -rn "LlmAdapter" packages/llm-agent-server/src/
```

If all matches are in `providers.ts` (now rewritten) and `adapters/llm-adapter.ts`, delete `adapters/llm-adapter.ts` and remove the re-export. If LlmAdapter has other uses (embedder wrapping, client adapter), preserve those and leave LlmAdapter in place.

- [ ] **Step 6: Build server**

```
cd packages/llm-agent-server && npm exec tsc -p tsconfig.json 2>&1 | head -30 && cd ../..
```

Iterate remaining errors — they'll point at stragglers that still reference Agent classes or moved provider paths.

- [ ] **Step 7: Run server tests**

```
cd packages/llm-agent-server && npm test 2>&1 | tail -20 && cd ../..
```

Fix failing tests. Any test that directly exercised `new OpenAIAgent(...)` is obsolete — either rewrite to use `new OpenAIProvider(...)` or delete with justification.

- [ ] **Step 8: Commit (Tasks 10 + 11 together)**

```
git add -A
git commit -m "refactor(server)!: remove Agent hierarchy; CLI/providers use SmartAgent+LLMProvider directly

- Delete packages/llm-agent-server/src/agents/ (BaseAgent + 5 concrete agents).
- Rewrite providers.ts to construct LLM providers directly from their packages.
- Rewrite cli.ts to use SmartAgentBuilder exclusively; mcp.type 'none' via omitted MCP config.
- Rewrite smoke-adapters.ts for new provider path.
- Delete LlmAdapter if no longer used.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Relocate factory registry with startup-prefetch + sync resolve

**Critical design note:** the current `resolveEmbedder()` / `makeRag()` call path is **synchronous**. Switching to `await import()` inside those functions would change their signatures and ripple through SmartServer composition, all config wiring, and every caller. To avoid that ripple, the extracted registry uses a two-phase pattern:

- **Phase 1 (server startup, async):** server reads its config, determines which factory names are referenced (e.g. `llm: deepseek`, `rag: ollama`), and `await import('@mcp-abap-adt/deepseek-llm')` / `await import('@mcp-abap-adt/ollama-embedder')` for each. Successful imports populate a module-level `prefetchedModules` map. Failed imports throw `MissingProviderError` immediately — server does not boot.
- **Phase 2 (runtime, sync):** `resolveEmbedder(name, opts)` and `resolveLlm(name, opts)` look up the prefetched module from the map and instantiate the class synchronously. Caller signatures unchanged.

This preserves the sync API surface consumers and existing callers rely on, while giving us the optional-peer semantic of dynamic resolution.

**Files:**
- `git mv`: `packages/llm-agent/src/rag/embedder-factories.ts` → `packages/llm-agent-server/src/smart-agent/embedder-factories.ts`
- Modify: `packages/llm-agent-server/src/smart-agent/embedder-factories.ts` — rewrite to use dynamic `import()` per factory name
- Create: `packages/llm-agent-server/src/smart-agent/llm-factories.ts` — analogous registry for LLM providers (extract the name → class mapping currently inline in `providers.ts` if that's how it's wired)
- Create: `packages/llm-agent/src/errors/missing-provider-error.ts` — typed error class (lives in core so all packages can import)
- Modify: `packages/llm-agent/src/index.ts` — export `MissingProviderError`

- [ ] **Step 1: Add `MissingProviderError` in core**

```ts
// packages/llm-agent/src/errors/missing-provider-error.ts
export class MissingProviderError extends Error {
  readonly code = 'MISSING_PROVIDER';
  readonly packageName: string;
  constructor(packageName: string, factoryName: string) {
    super(
      `Provider '${factoryName}' is declared in config but package '${packageName}' is not installed. Run: npm install ${packageName}`,
    );
    this.name = 'MissingProviderError';
    this.packageName = packageName;
  }
}
```

- [ ] **Step 2: Export it from core**

Add to `packages/llm-agent/src/index.ts`:

```ts
export { MissingProviderError } from './errors/missing-provider-error.js';
```

- [ ] **Step 3: Move `embedder-factories.ts` to server**

```
git mv packages/llm-agent/src/rag/embedder-factories.ts packages/llm-agent-server/src/smart-agent/embedder-factories.ts
```

Remove re-exports of `embedder-factories.ts` from core's `rag/index.ts` and core's `src/index.ts`.

- [ ] **Step 4: Rewrite the file to use startup-prefetch + sync resolve**

```ts
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';

export type EmbedderFactoryOpts = Record<string, unknown>;

const PACKAGE_BY_NAME: Record<string, string> = {
  openai: '@mcp-abap-adt/openai-embedder',
  ollama: '@mcp-abap-adt/ollama-embedder',
  'sap-ai-core': '@mcp-abap-adt/sap-aicore-embedder',
};

const EXPORT_BY_NAME: Record<string, string> = {
  openai: 'OpenAiEmbedder',
  ollama: 'OllamaEmbedder',
  'sap-ai-core': 'SapAiCoreEmbedder',
};

const prefetched = new Map<string, Record<string, unknown>>();

/**
 * Load the peer packages for the factory names given. Call once at server
 * startup before any synchronous resolve calls. Missing peer → throws
 * MissingProviderError up front so the server fails fast.
 */
export async function prefetchEmbedderFactories(names: readonly string[]): Promise<void> {
  for (const name of names) {
    if (prefetched.has(name)) continue;
    const packageName = PACKAGE_BY_NAME[name];
    if (!packageName) {
      throw new MissingProviderError('(unknown)', name);
    }
    try {
      const mod = (await import(packageName)) as Record<string, unknown>;
      prefetched.set(name, mod);
    } catch {
      throw new MissingProviderError(packageName, name);
    }
  }
}

/** Synchronous resolve. Call only AFTER prefetchEmbedderFactories has completed. */
export function resolveEmbedder(name: string, opts: EmbedderFactoryOpts): IEmbedder {
  const mod = prefetched.get(name);
  if (!mod) {
    const packageName = PACKAGE_BY_NAME[name] ?? '(unknown)';
    throw new MissingProviderError(packageName, name);
  }
  const className = EXPORT_BY_NAME[name];
  const Cls = mod[className] as new (opts: EmbedderFactoryOpts) => IEmbedder;
  if (!Cls) {
    throw new MissingProviderError(PACKAGE_BY_NAME[name] ?? '(unknown)', name);
  }
  return new Cls(opts);
}

export const builtInEmbedderFactories: Record<string, (opts: EmbedderFactoryOpts) => IEmbedder> = {
  openai: (opts) => resolveEmbedder('openai', opts),
  ollama: (opts) => resolveEmbedder('ollama', opts),
  'sap-ai-core': (opts) => resolveEmbedder('sap-ai-core', opts),
};
```

Export from server's index if it's public API; otherwise keep internal. The **public contract preserved** is the sync `resolveEmbedder` signature and the sync callable entries in `builtInEmbedderFactories`. The new piece is `prefetchEmbedderFactories(names)`, which server startup must call before entering any resolve path.

- [ ] **Step 5: Create `llm-factories.ts` with the same startup-prefetch + sync pattern**

Same shape but for `openai`, `anthropic`, `deepseek`, `sap-ai-core` and the `ILlm` interface. If the current `providers.ts` has direct if/else branches rather than a factory lookup, keep those branches (they use static imports and don't need the prefetch dance). Only use the factory registry where declarative config (`llm: deepseek`) needs runtime name resolution.

- [ ] **Step 5.5: Wire server startup to call the prefetch functions**

In `SmartServer` composition (or `cli.ts`, wherever config is parsed before pipeline construction), add:

```ts
import { prefetchEmbedderFactories } from './smart-agent/embedder-factories.js';
import { prefetchLlmFactories } from './smart-agent/llm-factories.js';

const embedderNames = [config.rag.type].filter((n) => n && n !== 'inmemory');
const llmNames = [config.llm.type].filter(Boolean);
await prefetchEmbedderFactories(embedderNames);
await prefetchLlmFactories(llmNames);
```

This call happens exactly once, at startup. After it returns, all downstream sync calls to `resolveEmbedder` / `resolveLlm` succeed.

- [ ] **Step 6: Build**

```
npm run build
```

Server should compile. Missing-peer branches are runtime errors, not compile errors.

- [ ] **Step 7: Write a test for `MissingProviderError` path**

`packages/llm-agent-server/src/smart-agent/__tests__/embedder-factories.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveEmbedder } from '../embedder-factories.js';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';

describe('resolveEmbedder', () => {
  it('throws MissingProviderError for unknown names', async () => {
    await assert.rejects(
      () => resolveEmbedder('does-not-exist', {}),
      (err: unknown) => err instanceof MissingProviderError,
    );
  });
});
```

Run it. Passes as long as `'does-not-exist'` is not in FACTORY_PACKAGE.

- [ ] **Step 8: Commit**

```
git add -A
git commit -m "feat(server)!: relocate factory registry with dynamic imports + MissingProviderError

- Move embedder-factories.ts from core to server.
- Add llm-factories.ts for LLM provider resolution.
- Factories dynamic-import the peer package; missing peer throws typed MissingProviderError with install hint.
- MissingProviderError lives in core for universal import.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Server peer dependencies + drop hard deps

**Files:**
- Modify: `packages/llm-agent-server/package.json`

- [ ] **Step 1: Rewrite `dependencies` and add `peerDependencies`**

```json
{
  "dependencies": {
    "@mcp-abap-adt/llm-agent": "*",
    "@modelcontextprotocol/sdk": "^1.28.0",
    "dotenv": "^17.3.1",
    "yaml": "^2.8.3",
    "zod": "^3.25.0"
  },
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
}
```

Note: `axios` is no longer in server's `dependencies` (it was only needed by providers now extracted). Remove it if it appears in server's current deps.

- [ ] **Step 2: Update `devDependencies` to include all peer packages**

For tests and dev builds to have all providers available, add every peer package to `devDependencies` too:

```json
"devDependencies": {
  "@mcp-abap-adt/openai-llm": "*",
  "@mcp-abap-adt/anthropic-llm": "*",
  "@mcp-abap-adt/deepseek-llm": "*",
  "@mcp-abap-adt/sap-aicore-llm": "*",
  "@mcp-abap-adt/openai-embedder": "*",
  "@mcp-abap-adt/ollama-embedder": "*",
  "@mcp-abap-adt/sap-aicore-embedder": "*",
  "@mcp-abap-adt/qdrant-rag": "*"
}
```

Preserve other existing devDependencies (biome, tsx, etc.).

- [ ] **Step 3: Update core's `package.json`**

Drop `axios` and `@sap-ai-sdk/orchestration` from core's `dependencies` — they're now only in the extracted packages. Core should list only `zod`:

```json
{
  "dependencies": {
    "zod": "^3.25.0"
  }
}
```

- [ ] **Step 4: `npm install` to refresh lockfile**

```
npm install
```

All workspace packages resolve. Server sees peers linked. Verify by `ls packages/llm-agent-server/node_modules/@mcp-abap-adt/`.

- [ ] **Step 5: Build + test**

```
npm run build && npm test 2>&1 | tail -5
```

All packages build; all tests pass.

- [ ] **Step 6: Commit**

```
git add -A packages/llm-agent-server/package.json packages/llm-agent/package.json package-lock.json
git commit -m "chore!: server provider packages become optional peers; core drops axios + SAP SDK

- packages/llm-agent-server peerDependencies: all 8 provider/embedder/qdrant packages, each marked optional.
- packages/llm-agent: runtime deps shrink to zod only.
- devDependencies for server include every peer so tests and dev builds have all providers available.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Drop back-compat re-exports

**Files:**
- Modify: `packages/llm-agent/src/index.ts`
- Modify: `packages/llm-agent/src/rag/index.ts`
- Modify: `packages/llm-agent-server/src/index.ts`

- [ ] **Step 1: Audit core's `src/index.ts` and `rag/index.ts`**

After Tasks 6-9 you already removed re-exports of `openai-embedder`, `ollama-embedder`, etc. from core. Confirm no lingering re-exports of symbols that live in extracted packages.

```
grep -n "export" packages/llm-agent/src/index.ts
grep -n "export" packages/llm-agent/src/rag/index.ts
```

Anything referencing `OpenAiEmbedder`, `SapAiCoreEmbedder`, `OllamaEmbedder`, `OllamaRag`, `QdrantRag`, `QdrantRagProvider`, `BaseLLMProvider` (if you moved it to core in Task 2, keep its core re-export), `OpenAIProvider`, `AnthropicProvider`, etc. — handle per category:

- `BaseLLMProvider` lives in core per Task 2 — **keep** its re-export.
- Everything else (embedders, Qdrant, providers) — **remove**.

- [ ] **Step 2: Audit server's `src/index.ts`**

```
grep -n "export" packages/llm-agent-server/src/index.ts
```

Remove any re-exports of extracted classes. Server should NOT re-export `OpenAIProvider`, `AnthropicProvider`, etc. Consumers import from the respective packages directly.

- [ ] **Step 3: Build + test**

```
npm run build && npm test 2>&1 | tail -5
```

If tests inside server or core imported through the now-removed re-exports, they fail. Fix each by updating to the canonical package path (e.g. `import { OpenAIProvider } from '@mcp-abap-adt/openai-llm'`).

- [ ] **Step 4: Commit**

```
git add -A
git commit -m "refactor!: drop v10 back-compat re-exports; each symbol lives in exactly one package

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Update `.changeset/config.json` fixed group

**Files:**
- Modify: `.changeset/config.json`

- [ ] **Step 1: Extend fixed group to ten packages**

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

- [ ] **Step 2: Commit**

```
git add .changeset/config.json
git commit -m "chore(changesets): lock-step all 10 v11 packages

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Write `docs/MIGRATION-v11.md`

**Files:**
- Create: `docs/MIGRATION-v11.md`
- Delete: `docs/MIGRATION-v10.md` (superseded)

- [ ] **Step 1: Write the migration guide**

Use the structure from the spec's "Migration for consumers" section:

1. **What broke** — back-compat re-exports gone; Agent hierarchy removed; server peer deps now explicit.
2. **Install modes** — three modes (server-managed declarative, programmatic server composition, core-only). Concrete install commands for each.
3. **Symbol → package mapping** — every symbol moved.
4. **Agent hierarchy removal** — before/after code snippets: `new OpenAIAgent(...)` → `new OpenAIProvider(...)` + SmartAgent pattern.
5. **CLI changes** — `llm-agent --llm-only` still works via `mcp.type: 'none'`; three bins unchanged.
6. **Dockerfile updates** — install server + exactly the peers named in the bundled smart-server.yaml.
7. **MissingProviderError handling** — example of the error message and how to fix.

Full content template matches the spec. Copy from spec's migration section; expand with concrete install commands for the three modes.

- [ ] **Step 2: Remove v10 migration doc**

```
git rm docs/MIGRATION-v10.md
```

v10 → v11 migration is cumulative; the single v11 doc covers what consumers need.

- [ ] **Step 3: Update root `README.md`**

Rewrite the Packages section to list all 10 packages (2 framework + 8 peers) with one-line descriptions. Update install snippets to show the three modes.

- [ ] **Step 4: Update `docs/QUICK_START.md`**

Example install: `npm install @mcp-abap-adt/llm-agent-server @mcp-abap-adt/deepseek-llm @mcp-abap-adt/ollama-embedder`.

- [ ] **Step 5: Update Dockerfiles in `examples/docker-*`**

Each Dockerfile's `RUN npm install` line names the specific peers for that example's `smart-server.yaml`.

- [ ] **Step 6: Commit**

```
git add -A docs/ README.md examples/
git commit -m "docs: MIGRATION-v11 + monorepo README + Dockerfile install commands

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Bump to 11.0.0 via changeset

**Files:**
- Create: `.changeset/v11-full-extraction.md`
- Modify: all per-package `package.json` (via `changeset version`)

- [ ] **Step 1: Write the changeset file**

```
cat > .changeset/v11-full-extraction.md <<'EOF'
---
"@mcp-abap-adt/llm-agent": major
"@mcp-abap-adt/llm-agent-server": major
---

Complete provider and backend extraction. Eight new packages shipped:
@mcp-abap-adt/openai-llm, anthropic-llm, deepseek-llm, sap-aicore-llm,
openai-embedder, ollama-embedder, sap-aicore-embedder, qdrant-rag.

Breaking changes:
- Back-compat re-exports from v10.0 removed. Each symbol lives in exactly
  one package. See docs/MIGRATION-v11.md for the symbol-by-symbol table.
- Non-Smart Agent hierarchy removed. Use SmartAgent + a provider class
  directly.
- Core runtime dep shrinks to zod only; axios and @sap-ai-sdk/* move to
  their respective extracted packages.
- Server provider dependencies are optional peer deps. Install only the
  peers your smart-server.yaml names. Missing peer throws
  MissingProviderError at startup.
EOF
```

- [ ] **Step 2: Run `changeset version`**

```
npx changeset version
```

Bumps all 10 packages to 11.0.0 (fixed group). Writes per-package CHANGELOG.md. Deletes the changeset file.

- [ ] **Step 3: Verify all versions**

```
grep '"version"' packages/*/package.json
```

All ten show `"version": "11.0.0"`.

- [ ] **Step 4: Build + test**

```
npm run build && npm test 2>&1 | tail -5
```

Clean build and all tests pass.

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "chore: release 11.0.0 - complete provider and backend extraction

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: Validation task 1 — Declarative-server boot test

- [ ] **Step 1: Create a temp directory outside the monorepo**

```
mkdir -p /tmp/v11-boot-test && cd /tmp/v11-boot-test
npm init -y
```

- [ ] **Step 2: Install server + peers named in default smart-server.yaml**

Check the default config to see which peers are named:

```
grep -A 5 "^llm:\|^rag:" /path/to/default/smart-server.yaml
```

Typical defaults: `llm: deepseek`, `rag: ollama`. Install:

```
npm install @mcp-abap-adt/llm-agent-server@11.0.0 @mcp-abap-adt/deepseek-llm@11.0.0 @mcp-abap-adt/ollama-embedder@11.0.0
```

(For local unpublished testing, point these at file:../../packages/... paths.)

- [ ] **Step 3: Copy default smart-server.yaml**

```
cp /home/okyslytsia/prj/llm-agent/packages/llm-agent-server/smart-server.yaml .
```

- [ ] **Step 4: Boot the server in LLM-only mode**

```
npx @mcp-abap-adt/llm-agent-server --config smart-server.yaml --llm-only
```

Expected: server boots, prints startup log, accepts a test request. If it crashes with `MissingProviderError`, the peer list is incomplete — investigate.

- [ ] **Step 5: Negative test: install without one peer**

```
npm uninstall @mcp-abap-adt/ollama-embedder
npx @mcp-abap-adt/llm-agent-server --config smart-server.yaml
```

Expected: startup aborts with `MissingProviderError: Provider 'ollama' is declared in config but package '@mcp-abap-adt/ollama-embedder' is not installed.` The message is user-friendly and names the exact install command.

- [ ] **Step 6: Record result**

Create `/tmp/v11-boot-test/RESULT.md` noting whether both tests passed. If either failed, STOP and investigate before tagging v11.0.0.

No commit for validation tasks — they're gates, not code.

---

## Task 19: Validation task 2 — Minimal-install composition test

- [ ] **Step 1: Create a fresh temp project**

```
mkdir -p /tmp/v11-minimal-test && cd /tmp/v11-minimal-test
npm init -y
```

- [ ] **Step 2: Install only the minimal set**

```
npm install @mcp-abap-adt/llm-agent-server@11.0.0 @mcp-abap-adt/deepseek-llm@11.0.0 @mcp-abap-adt/ollama-embedder@11.0.0
```

Verify `node_modules` does NOT contain anthropic-llm, sap-aicore-*, openai-embedder. Only the three installed + transitive `llm-agent`, `openai-llm` (pulled by deepseek-llm).

```
ls node_modules/@mcp-abap-adt/
```

Expected: `deepseek-llm/`, `llm-agent/`, `llm-agent-server/`, `ollama-embedder/`, `openai-llm/` (5 directories).

- [ ] **Step 3: Programmatic composition script**

`script.js`:

```js
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-server';
import { DeepSeekProvider } from '@mcp-abap-adt/deepseek-llm';
import { OllamaEmbedder } from '@mcp-abap-adt/ollama-embedder';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent';

const llm = new DeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY, model: 'deepseek-chat' });
const embedder = new OllamaEmbedder({ ollamaUrl: 'http://localhost:11434', model: 'nomic-embed-text' });
// SmartAgentBuilder does not take an embedder directly; it takes RAG stores.
// For a minimal test, wire a VectorRag or InMemoryRag backed by the embedder.
const toolsRag = new InMemoryRag();

const agent = await new SmartAgentBuilder()
  .withMainLlm(llm)
  .setToolsRag(toolsRag)
  .build();

const reply = await agent.chat([{ role: 'user', content: 'Hello' }]);
console.log(reply);
```

**Note:** the actual builder API is `withMainLlm`, not `setMainLlm`. Embedders are not a first-class builder dependency — they're wired through RAG stores. For a full test, import `VectorRag` from core and pass the embedder to its constructor, then `setToolsRag(vectorRag)`. Grep `packages/llm-agent-server/src/smart-agent/builder.ts` for the exact `with*`/`set*` methods available before calling.

Run: `node --experimental-vm-modules script.js` (or equivalent for ESM).

Expected: agent responds. (If DeepSeek key isn't set, expect auth error — still validates the composition path; record as expected.)

- [ ] **Step 4: Negative test: missing peer via MissingProviderError**

This test asserts that `MissingProviderError` is thrown when a config names an uninstalled peer. The public entry for triggering this is the server's config-driven startup — not a direct `resolveEmbedder` import (which is a server-internal symbol, not a documented public API).

Two options to test it:

**Option A (recommended) — exercise via the public server startup path:**

```js
import { SmartServer } from '@mcp-abap-adt/llm-agent-server/smart-server';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';

const configYaml = `
llm:
  type: deepseek
  apiKey: test
rag:
  type: sap-ai-core    # peer @mcp-abap-adt/sap-aicore-embedder is NOT installed in this test
`;

try {
  const server = await SmartServer.fromYaml(configYaml);
  await server.start();
  console.log('FAIL: expected MissingProviderError');
} catch (err) {
  if (err instanceof MissingProviderError) {
    console.log('OK: MissingProviderError thrown');
  } else {
    console.log('FAIL: wrong error type:', err);
  }
}
```

**Option B (if `SmartServer.fromYaml` is not a stable public API)** — add a public export for the `prefetchEmbedderFactories(names)` function (Task 12), call it with `['sap-ai-core']`, and assert the error. This requires server to declare the export explicitly (e.g. `"./factories": "./dist/smart-agent/embedder-factories.js"` in the package `exports`) and Task 12 must add that export. Prefer Option A; fall back to B only if the validation script can't easily construct a SmartServer.

Expected: `OK: MissingProviderError thrown`.

- [ ] **Step 5: Record result**

Update `/tmp/v11-minimal-test/RESULT.md`. If any step fails, STOP and investigate before tagging.

---

## Task 20: Validation task 3 — Core-only interface compatibility test

- [ ] **Step 1: Create a fresh temp project**

```
mkdir -p /tmp/v11-core-only-test && cd /tmp/v11-core-only-test
npm init -y
```

- [ ] **Step 2: Install ONLY core**

```
npm install @mcp-abap-adt/llm-agent@11.0.0
```

Verify `node_modules/@mcp-abap-adt/` contains only `llm-agent/`.

- [ ] **Step 3: Write a minimal consumer script using core interfaces**

`script.js`:

```js
import { InMemoryRag, DirectEditStrategy, SimpleRagRegistry } from '@mcp-abap-adt/llm-agent';

const rag = new InMemoryRag();
const editor = new DirectEditStrategy(rag.writer(), undefined);
const registry = new SimpleRagRegistry();
registry.register('scratch', rag, editor);

// write → read sanity
await editor.upsert('hello world', { id: 'h1' });
const hit = await rag.query({ text: 'hello', vector: null }, 1);
console.log(hit.ok ? hit.value : hit.error);
```

Run: `node script.js`.

Expected: prints a RagResult array. If the query or upsert fails, core's public API is incomplete — investigate.

- [ ] **Step 4: Stub-ILlm test**

Verify you can write your own ILlm without server:

```js
import type { ILlm } from '@mcp-abap-adt/llm-agent';

const myLlm: ILlm = {
  chat: async () => ({ content: 'stub response', finishReason: 'stop', raw: {} }),
  streamChat: async function* () { yield { content: 'stub', finishReason: 'stop', raw: {} }; },
};

// Use myLlm somewhere — compile check that ILlm type is fully exported from core
```

If TypeScript is missing `ILlm` from core's surface, fix core's `index.ts` and rerun.

- [ ] **Step 5: Record result**

Update `/tmp/v11-core-only-test/RESULT.md`.

---

## Task 21: Final verification + PR

- [ ] **Step 1: Clean build + lint + tests**

```
cd /home/okyslytsia/prj/llm-agent
npm run clean && npm install && npm run lint:check && npm run build && npm test 2>&1 | tail -5
```

All four must exit 0.

- [ ] **Step 2: Push branch**

```
git push -u origin feat/v11-full-extraction
```

- [ ] **Step 3: Open PR**

```
gh pr create --title "feat!: v11.0.0 complete provider and backend extraction" --body "$(cat <<'EOF'
## Summary

Extracts 8 new packages (LLM providers, embedders, QdrantRag). Removes non-Smart Agent hierarchy. Makes server provider dependencies optional peers with dynamic-import resolution + typed MissingProviderError. Core runtime dep shrinks to zod only.

## Breaking changes

See \`docs/MIGRATION-v11.md\` for symbol-by-symbol mapping and install-command updates.

## Validation

- [x] Declarative-server boot test
- [x] Minimal-install composition test
- [x] Core-only interface compatibility test

## Packages released at 11.0.0

10 total: llm-agent, llm-agent-server, openai-llm, anthropic-llm, deepseek-llm, sap-aicore-llm, openai-embedder, ollama-embedder, sap-aicore-embedder, qdrant-rag.
EOF
)"
```

- [ ] **Step 4: After merge — publish via changesets**

```
git checkout main && git pull
npx changeset publish
git tag -a v11.0.0 -m "Release 11.0.0 — complete provider and backend extraction"
git push origin v11.0.0
```

- [ ] **Step 5: Delete spec and plan per retention policy**

```
git checkout -b chore/cleanup-v11-artifacts
git rm docs/superpowers/specs/2026-04-22-v11-full-extraction-design.md docs/superpowers/plans/2026-04-23-v11-full-extraction.md
git commit -m "chore(docs): remove v11 spec and plan (implemented)"
gh pr create --title "chore: cleanup v11 spec/plan" --body "Per retention policy."
gh pr merge --merge --delete-branch
```

---

## Notes

- **Extraction tasks (2-9) mirror each other** — follow Task 2 exactly, substituting package name, directory, source file, and dependencies. Resist rewriting provider logic.
- **Task 12's dynamic-import pattern** is the key correctness invariant. Hardcoded `import { X } from 'Y'` at the top of embedder-factories.ts would force every peer to be a hard dependency. Use `await import(name)` in the function body.
- **Task 18-20 are non-coding validation** — they are mandatory go/no-go gates, not software artifacts. Record results; don't commit them.
- **Biome lint scope stays at `packages/`** — nothing in docs/ or examples/ lint-gates.
- **Pre-merge CI** runs on Node 22 (v10.0 baseline). No Node-version change needed.
- **If any extraction fails mid-plan**, git reset the specific package's commit and retry — each extraction is one commit, independently revertable.

## Review history (resolved)

- Task 12 originally proposed async `resolveEmbedder`/`resolveLlm` signatures, which would have rippled through SmartServer and every caller → **resolved** by the startup-prefetch + sync-resolve pattern: phase 1 `await import(peer)` at server startup; phase 2 sync lookups. Sync API surface preserved.
- Task 11 used non-existent builder methods (`setMainLlm`/`setMcp`) → **resolved** by rewriting against the actual API (`withMainLlm`, `withMcpClients`) with an explicit instruction to grep builder.ts before each call.
- Task 2 package skeleton had `"version": "10.0.0"` → **resolved** by updating Tasks 2-9 template to `"version": "11.0.0"` matching the release line.
- `BaseLLMProvider` location was forced as a mid-Task-2 decision without spec support → **resolved** by adding an explicit decision sub-task in Task 2 with three options and fallback guidance.
- Validation Task 19 used stale builder calls `setMainLlm`/`setEmbedder` → **resolved** by rewriting the snippet with `withMainLlm` + `setToolsRag`, noting that embedders aren't a first-class builder dependency and must be wired through a RAG store.
- Validation Task 19 imported `resolveEmbedder` from an undocumented subpath → **resolved** by rewriting the negative test around `SmartServer.fromYaml` (public API) with a fallback option B that documents how to add an explicit subpath export if needed.
- File map described `base.ts` as ambiguous ("stays in server OR moves") after Task 2 made it a concrete decision → **resolved** by updating the file map to state the move explicitly with the fallback noted.
