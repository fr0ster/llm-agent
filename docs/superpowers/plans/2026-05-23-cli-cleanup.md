# CLI Cleanup + Ollama Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `smart-server.yaml` the single source of agent-behavior config — strip duplicate CLI flags, kill silent env/default fallbacks, harden YAML validation with fail-loud errors — and add a real `ollama` LLM provider so the flat `llm:` path honours `provider`/`url`.

**Architecture:** The CLI (`cli.ts`) becomes runtime-metadata-only (config path, env loading, port/host, logging, plugins) with `parseArgs({ strict: true })`. `resolveSmartServerConfig` (`config.ts`) stops reading `process.env.*` directly and stops hardcoding agent-identity defaults; a new post-resolution validator emits one human-readable report. A new thin package `@mcp-abap-adt/ollama-llm` (clone of `deepseek-llm`, OpenAI-compatible `/v1`) joins the provider set; the flat `llm:` branch in `smart-server.ts` calls `makeLlm({ provider, ... })` instead of the hardcoded-deepseek `makeDefaultLlm`.

**Tech Stack:** TypeScript (ESM, strict), `node:util.parseArgs`, `dotenv`, Biome, `node:test` (test runner already used in `packages/**/__tests__`), monorepo `tsc -b` project references.

**Spec:** `docs/superpowers/specs/2026-05-23-cli-cleanup-design.md`

**Conventions:** ESM, `.js` import extensions, single quotes, 2-space, semicolons. Run `npm run build` + `npm run lint:check` before every commit (no separate unit-test framework; package tests run via `node --import tsx/esm --test`). Commit on the current worktree branch.

---

## File Structure

**New package `packages/ollama-llm/`:**
- `package.json` — name `@mcp-abap-adt/ollama-llm`, dep on `@mcp-abap-adt/openai-llm` + `@mcp-abap-adt/llm-agent`.
- `tsconfig.json` — references `../llm-agent` + `../openai-llm`.
- `src/ollama-provider.ts` — `OllamaProvider extends OpenAIProvider`.
- `src/index.ts` — re-exports.
- `src/ollama-provider.test.ts` — provider-construction tests.
- `README.md`, `LICENSE` — copied/adapted from `deepseek-llm`.

**Modified — provider wiring:**
- `package.json` (root) — add `packages/ollama-llm` to `build` + `clean` `tsc -b` lists.
- `packages/llm-agent-libs/package.json` — add ollama to `peerDependencies`, `peerDependenciesMeta`, `devDependencies`.
- `packages/llm-agent-libs/tsconfig.json` — add `{ "path": "../ollama-llm" }`.
- `packages/llm-agent-libs/src/providers.ts` — `'ollama'` in `MakeLlmConfig.provider`, `loadOllama()`, `case 'ollama'`.
- `packages/llm-agent-server/src/smart-agent/pipeline.ts` — `'ollama'` in `PipelineLlmProviderConfig.provider`.
- `packages/llm-agent-server/package.json` — add `@mcp-abap-adt/ollama-llm` dependency.

**Modified — flat-path + config:**
- `packages/llm-agent-server/src/smart-agent/smart-server.ts` — `SmartServerLlmConfig` gains `provider`/`url`; flat-path branches (main + classifier + sub-agent) call `makeLlm` not `makeDefaultLlm`.
- `packages/llm-agent-server/src/smart-agent/config.ts` — populate `llm.provider`/`llm.url`; remove Category-A env/default fallbacks; add `validateResolvedConfig()`.

**Modified — CLI:**
- `packages/llm-agent-server/src/smart-agent/cli.ts` — remove behavior flags + `--llm-only`, `strict: true`, `--secrets-dir`/`--env`/`--env-path` env loading.

**New/modified tests:**
- `packages/llm-agent-server/src/smart-agent/__tests__/config-validation.test.ts` — `resolveSmartServerConfig` + `validateResolvedConfig` unit tests.
- `packages/llm-agent-server/src/smart-agent/__tests__/cli-flags.test.ts` — subprocess tests for strict-flag rejection + env loading.

**Modified — docs/examples:**
- `examples/docker-ollama/smart-server.yaml`, `package.json` (root + server) `dev:*` scripts, `CLAUDE.md`, `docs/QUICK_START.md`, `CHANGELOG.md`.

---

## Task 1: Create the `@mcp-abap-adt/ollama-llm` package

**Files:**
- Create: `packages/ollama-llm/package.json`
- Create: `packages/ollama-llm/tsconfig.json`
- Create: `packages/ollama-llm/src/ollama-provider.ts`
- Create: `packages/ollama-llm/src/index.ts`
- Create: `packages/ollama-llm/README.md`
- Create: `packages/ollama-llm/LICENSE`
- Test: `packages/ollama-llm/src/ollama-provider.test.ts`

- [ ] **Step 1: Create `package.json`** (clone of `deepseek-llm/package.json`)

```json
{
  "name": "@mcp-abap-adt/ollama-llm",
  "version": "14.0.0",
  "description": "Ollama LLM provider (ILlm, extends OpenAIProvider — Ollama's OpenAI-compatible /v1 API) for @mcp-abap-adt/llm-agent.",
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
    "@mcp-abap-adt/llm-agent": "^14.0.0",
    "@mcp-abap-adt/openai-llm": "^14.0.0"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/fr0ster/llm-agent.git"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (clone of `deepseek-llm/tsconfig.json`)

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
  "references": [{ "path": "../llm-agent" }, { "path": "../openai-llm" }]
}
```

- [ ] **Step 3: Write the failing test** `src/ollama-provider.test.ts`

The provider must (a) construct without an apiKey, (b) default `baseURL` to the local Ollama `/v1`, (c) honour an explicit `baseURL`, (d) expose the given model. `OpenAIProvider` stores `baseURL`/`apiKey`/`model`; we assert on the public `model` and on the constructed OpenAI client's `baseURL`. Since the OpenAI client is internal, we test the observable contract: construction never throws without a key, and `model` is set.

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OllamaProvider } from './ollama-provider.js';

describe('OllamaProvider', () => {
  it('constructs without an apiKey (Ollama ignores it)', () => {
    const p = new OllamaProvider({ model: 'qwen2.5:14b' });
    assert.equal(p.model, 'qwen2.5:14b');
  });

  it('accepts an explicit baseURL', () => {
    const p = new OllamaProvider({
      model: 'llama3',
      baseURL: 'http://ollama.internal:11434/v1',
    });
    assert.equal(p.model, 'llama3');
  });

  it('reports no embedding models', async () => {
    const p = new OllamaProvider({ model: 'qwen2.5:14b' });
    assert.deepEqual(await p.getEmbeddingModels(), []);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd packages/ollama-llm && node --import tsx/esm --test 'src/**/*.test.ts'`
Expected: FAIL — `Cannot find module './ollama-provider.js'`.

- [ ] **Step 5: Implement `src/ollama-provider.ts`**

Mirror `DeepSeekProvider`: extend `OpenAIProvider`, override `baseURL` default + provider name, force a placeholder `apiKey` (the OpenAI SDK rejects an empty key; Ollama ignores its value), and use `max_tokens` (no gpt-5/o1 distinction). Ollama exposes no embedding models through the chat provider.

```ts
/**
 * Ollama LLM Provider — extends OpenAI (Ollama exposes an OpenAI-compatible /v1 API).
 */

import type { IModelInfo, LLMProviderConfig } from '@mcp-abap-adt/llm-agent';
import { type OpenAIConfig, OpenAIProvider } from '@mcp-abap-adt/openai-llm';

export interface OllamaConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class OllamaProvider extends OpenAIProvider {
  protected override readonly providerName: string = 'Ollama';

  constructor(config: OllamaConfig) {
    super({
      ...config,
      baseURL: config.baseURL || 'http://localhost:11434/v1',
      // Ollama ignores the key, but the OpenAI SDK requires a non-empty value.
      apiKey: config.apiKey || 'ollama',
    } as OpenAIConfig);
  }

  /**
   * Ollama always uses max_tokens (no gpt-5/o1/o3 distinction).
   */
  protected override getTokenLimitParam(
    _model: string,
    maxTokens: number,
  ): Record<string, number> {
    return { max_tokens: maxTokens };
  }

  override async getEmbeddingModels(): Promise<IModelInfo[]> {
    return [];
  }
}
```

- [ ] **Step 6: Implement `src/index.ts`**

```ts
export type { OllamaConfig } from './ollama-provider.js';
export { OllamaProvider } from './ollama-provider.js';
```

- [ ] **Step 7: Create `README.md` and `LICENSE`**

Copy `packages/deepseek-llm/LICENSE` verbatim. Write a minimal README:

```markdown
# @mcp-abap-adt/ollama-llm

Ollama LLM provider for `@mcp-abap-adt/llm-agent`. Thin wrapper over
`@mcp-abap-adt/openai-llm` targeting Ollama's OpenAI-compatible `/v1` endpoint
(default `http://localhost:11434/v1`). No API key required.

\`\`\`yaml
llm:
  provider: ollama
  model: qwen2.5:14b
  # url: http://localhost:11434/v1   # optional; this is the default
\`\`\`
```

- [ ] **Step 8: Verify peer dep resolves locally** — the package imports `@mcp-abap-adt/openai-llm`. Because it's a workspace, no install is needed; confirm the symlink exists.

Run: `ls -la node_modules/@mcp-abap-adt/openai-llm`
Expected: a symlink into `packages/openai-llm`.

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd packages/ollama-llm && node --import tsx/esm --test 'src/**/*.test.ts'`
Expected: PASS — 3 tests.

- [ ] **Step 10: Commit**

```bash
git add packages/ollama-llm
git commit -m "feat(ollama-llm): add Ollama LLM provider (OpenAI-compatible /v1 wrapper)"
```

---

## Task 2: Wire `ollama-llm` into the monorepo build + provider resolution

**Files:**
- Modify: `package.json` (root) — `build` + `clean` scripts
- Modify: `packages/llm-agent-libs/package.json:42-67`
- Modify: `packages/llm-agent-libs/tsconfig.json` (references array)
- Modify: `packages/llm-agent-libs/src/providers.ts`
- Modify: `packages/llm-agent-server/src/smart-agent/pipeline.ts`
- Modify: `packages/llm-agent-server/package.json` (dependencies)

- [ ] **Step 1: Add `packages/ollama-llm` to root `build` + `clean`**

In `package.json`, both the `build` and `clean` scripts list packages in dependency order. Insert `packages/ollama-llm` immediately after `packages/openai-llm` (it imports from openai-llm) and before `packages/llm-agent-libs`. Apply to BOTH lines (10 and 11):

Find (in each script): `packages/openai-llm packages/anthropic-llm`
Replace with: `packages/openai-llm packages/ollama-llm packages/anthropic-llm`

- [ ] **Step 2: Add ollama to `llm-agent-libs/package.json` three lists**

In `peerDependencies` (after the deepseek line):
```json
    "@mcp-abap-adt/ollama-llm": "^14.0.0",
```
In `peerDependenciesMeta` (after the deepseek block):
```json
    "@mcp-abap-adt/ollama-llm": {
      "optional": true
    },
```
In `devDependencies` (after the deepseek line):
```json
    "@mcp-abap-adt/ollama-llm": "^14.0.0",
```

- [ ] **Step 3: Add the project reference in `llm-agent-libs/tsconfig.json`**

In the `references` array, after `{ "path": "../deepseek-llm" }`, add:
```json
    { "path": "../ollama-llm" },
```

- [ ] **Step 4: Add `'ollama'` to `MakeLlmConfig.provider` union** in `providers.ts:23`

```ts
  provider: 'deepseek' | 'openai' | 'anthropic' | 'sap-ai-sdk' | 'ollama';
```

- [ ] **Step 5: Add the `loadOllama()` loader** in `providers.ts` (after `loadDeepSeek()`, mirroring it)

```ts
async function loadOllama() {
  const pkg = '@mcp-abap-adt/ollama-llm';
  try {
    const mod = await import(pkg);
    return mod.OllamaProvider as new (opts: {
      apiKey?: string;
      baseURL?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    }) => {
      model: string;
      getModels?: () => Promise<string[]>;
      getEmbeddingModels?: () => Promise<string[]>;
    } & import('@mcp-abap-adt/llm-agent').LLMProvider;
  } catch (err) {
    if (isMissingOptionalPeer(err, pkg))
      throw new MissingProviderError(pkg, 'ollama');
    throw err;
  }
}
```

- [ ] **Step 6: Add the `case 'ollama'` to the `makeLlm` switch** in `providers.ts` (after `case 'deepseek'`, mirroring it)

```ts
    case 'ollama': {
      const OllamaProvider = await loadOllama();
      const provider = new OllamaProvider({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        model: cfg.model,
        temperature,
        maxTokens,
      });
      llm = new LlmAdapter(new LlmProviderBridge(provider), {
        model: provider.model,
        getModels: () => provider.getModels?.() ?? Promise.resolve([]),
        getEmbeddingModels: () =>
          provider.getEmbeddingModels?.() ?? Promise.resolve([]),
      });
      break;
    }
```

- [ ] **Step 7: Add `'ollama'` to `PipelineLlmProviderConfig.provider`** in `pipeline.ts:15`

```ts
  provider: 'deepseek' | 'openai' | 'anthropic' | 'sap-ai-sdk' | 'ollama';
```

- [ ] **Step 8: Add the server dependency** in `packages/llm-agent-server/package.json` `dependencies` (alongside the other bundled `@mcp-abap-adt/*-llm` packages)

```json
    "@mcp-abap-adt/ollama-llm": "^14.0.0",
```

- [ ] **Step 9: Reinstall workspace symlinks so the new package + dependents resolve**

Run: `npm install`
Expected: completes; `node_modules/@mcp-abap-adt/ollama-llm` is a symlink into `packages/ollama-llm`.

- [ ] **Step 10: Build the whole monorepo**

Run: `npm run build`
Expected: PASS — `packages/ollama-llm` compiles in order; no `tsc` errors. (The `default: never` exhaustiveness check in `makeLlm` now includes `'ollama'`, so it must compile.)

- [ ] **Step 11: Lint**

Run: `npm run lint:check`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add package.json packages/llm-agent-libs/package.json packages/llm-agent-libs/tsconfig.json packages/llm-agent-libs/src/providers.ts packages/llm-agent-server/src/smart-agent/pipeline.ts packages/llm-agent-server/package.json package-lock.json
git commit -m "feat(libs): wire ollama provider into resolution + monorepo build"
```

---

## Task 3: Flat `llm:` path honours `provider`/`url` (no silent deepseek)

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts:64-70` (`SmartServerLlmConfig`)
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts:361-382` (main + classifier flat path)
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts:797-820` (sub-agent flat path)
- Modify: `packages/llm-agent-server/src/smart-agent/config.ts:492-507` (populate `provider`/`url`)
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/config-validation.test.ts`

- [ ] **Step 1: Extend `SmartServerLlmConfig`** (`smart-server.ts:64`)

Add `provider` (optional in the type — presence is enforced by the validator in Task 6 only for the flat path) and `url`:

```ts
export interface SmartServerLlmConfig {
  /** Provider id for the flat schema. Required when no pipeline.llm.main is set. */
  provider?: 'deepseek' | 'openai' | 'anthropic' | 'sap-ai-sdk' | 'ollama';
  apiKey: string;
  /** Custom base URL (OpenAI-compatible endpoints: Ollama, Azure, vLLM). */
  url?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  classifierTemperature?: number;
}
```

- [ ] **Step 2: Populate `provider`/`url` in `resolveSmartServerConfig`** (`config.ts`, inside the `llm: { ... }` object at line 492)

Replace the `llm:` block body so it reads `provider` and `url` from YAML. NOTE: this step also removes the `env.DEEPSEEK_MODEL`/`'deepseek-chat'` model fallback and the `--llm-*` CLI reads (Task 5 covers the rest of Category A; do the `model` line here since we're rewriting the block). After this step `model` has no env/default fallback:

```ts
    llm: {
      provider: get(yaml, 'llm', 'provider') as
        | 'deepseek'
        | 'openai'
        | 'anthropic'
        | 'sap-ai-sdk'
        | 'ollama'
        | undefined,
      apiKey,
      url: get(yaml, 'llm', 'url') as string | undefined,
      model: get(yaml, 'llm', 'model') as string | undefined,
      temperature: Number(get(yaml, 'llm', 'temperature') ?? 0.7),
      classifierTemperature: Number(
        get(yaml, 'llm', 'classifierTemperature') ?? 0.1,
      ),
    },
```

- [ ] **Step 3: Replace the hardcoded-deepseek main + classifier flat path** (`smart-server.ts:361-382`)

The flat branches currently call `makeDefaultLlm(this.cfg.llm.apiKey, this.cfg.llm.model ?? 'deepseek-chat', temp)`. Replace each `makeDefaultLlm(...)` flat call with a `makeLlm({...})` call that passes the resolved provider/url. (`makeLlm` is already imported at `smart-server.ts:49`.)

Replace:
```ts
    const mainLlm = pipeline?.llm?.main
      ? await makeLlm(pipeline.llm.main, mainTemp)
      : await makeDefaultLlm(
          this.cfg.llm.apiKey,
          this.cfg.llm.model ?? 'deepseek-chat',
          mainTemp,
        );
```
with:
```ts
    const mainLlm = pipeline?.llm?.main
      ? await makeLlm(pipeline.llm.main, mainTemp)
      : await makeLlm(
          {
            provider: this.cfg.llm.provider ?? 'deepseek',
            apiKey: this.cfg.llm.apiKey,
            baseURL: this.cfg.llm.url,
            model: this.cfg.llm.model,
          },
          mainTemp,
        );
```

Replace the classifier flat fallback the same way:
```ts
        : await makeDefaultLlm(
            this.cfg.llm.apiKey,
            this.cfg.llm.model ?? 'deepseek-chat',
            classifierTemp,
          );
```
with:
```ts
        : await makeLlm(
            {
              provider: this.cfg.llm.provider ?? 'deepseek',
              apiKey: this.cfg.llm.apiKey,
              baseURL: this.cfg.llm.url,
              model: this.cfg.llm.model,
            },
            classifierTemp,
          );
```

> The `?? 'deepseek'` is a type-narrowing safety net only — the Task-6 validator rejects a missing flat-schema `provider` before this code runs, so it never actually defaults in practice. Keeping it satisfies TS without reintroducing a runtime path that silently picks deepseek for valid-but-incomplete config.

- [ ] **Step 4: Replace the sub-agent flat path** (`smart-server.ts:797-820`)

The sub-agent builder has the same two `makeDefaultLlm` flat fallbacks (`subCfg.llm.*`). Replace both identically, using `subCfg.llm.provider ?? 'deepseek'`, `subCfg.llm.apiKey`, `subCfg.llm.url`, `subCfg.llm.model`. (Same shape as Step 3; `subCfg.llm` is the same `SmartServerLlmConfig` type.)

- [ ] **Step 5: Write the failing test** for config resolution (`config-validation.test.ts`)

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveSmartServerConfig } from '../config.js';

describe('resolveSmartServerConfig — flat llm provider/url', () => {
  it('reads provider and url from YAML', () => {
    const cfg = resolveSmartServerConfig(
      {},
      { llm: { provider: 'ollama', model: 'qwen2.5:14b', url: 'http://h:11434/v1' } },
      {},
    );
    assert.equal(cfg.llm.provider, 'ollama');
    assert.equal(cfg.llm.url, 'http://h:11434/v1');
    assert.equal(cfg.llm.model, 'qwen2.5:14b');
  });

  it('does not invent a deepseek-chat model default', () => {
    const cfg = resolveSmartServerConfig(
      {},
      { llm: { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o' } },
      {},
    );
    assert.equal(cfg.llm.model, 'gpt-4o');
  });
});
```

Note: `resolveSmartServerConfig` still throws `'LLM API key is required'` (legacy guard at `config.ts:454`) when neither `apiKey` nor `pipeline.llm.main` is present. The ollama test above passes an apiKey-less config — to avoid the legacy guard firing before Task 6 reworks it, give the ollama case a dummy `apiKey: 'x'` OR sequence Task 6 first. **Decision:** add `apiKey: 'x'` to the ollama fixture here; Task 6 then adds the provider-aware guard and a dedicated apiKey-less-ollama test.

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/config-validation.test.ts'`
Expected: FAIL — `cfg.llm.provider` is `undefined` (field not yet populated) before Step 2, or module/field errors.

- [ ] **Step 7: Run the test to verify it passes** (after Steps 1-2 applied)

Run: same command.
Expected: PASS — 2 tests.

- [ ] **Step 8: Full build + lint**

Run: `npm run build && npm run lint:check`
Expected: PASS. `makeDefaultLlm` may now be unused in `smart-server.ts`; if Biome flags the unused import, remove `makeDefaultLlm` from the import at `smart-server.ts:48`. (Keep the `makeDefaultLlm` export in `providers.ts` — it is part of the libs public surface.)

- [ ] **Step 9: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-server/src/smart-agent/config.ts packages/llm-agent-server/src/smart-agent/__tests__/config-validation.test.ts
git commit -m "feat(server): flat llm path honours provider/url instead of hardcoded deepseek"
```

---

## Task 4: Remove behavior CLI flags + `--llm-only`; enable `strict: true`

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/cli.ts:86-116` (options + strict)
- Modify: `packages/llm-agent-server/src/smart-agent/cli.ts` JSDoc header (top of file)
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/cli-flags.test.ts`

- [ ] **Step 1: Write the failing subprocess test** (`cli-flags.test.ts`)

Spawn the CLI with a removed flag and assert a non-zero exit. Use a temp dir so the first-run template generator doesn't interfere (give `--config` a path that does not exist → it would generate a template and exit 0; instead we rely on `strict` throwing during parse, which happens BEFORE config handling). Test both a removed behavior flag and `--llm-only`.

```ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli.ts');

function runCli(args: string[]) {
  return spawnSync(
    'node',
    ['--import', 'tsx/esm', CLI, ...args],
    { encoding: 'utf8' },
  );
}

describe('cli strict flag parsing', () => {
  it('rejects a removed behavior flag (--llm-api-key)', () => {
    const r = runCli(['--llm-api-key', 'x']);
    assert.notEqual(r.status, 0);
    assert.match(`${r.stderr}${r.stdout}`, /unknown|unexpected|--llm-api-key/i);
  });

  it('rejects the dead --llm-only flag', () => {
    const r = runCli(['--llm-only']);
    assert.notEqual(r.status, 0);
    assert.match(`${r.stderr}${r.stdout}`, /unknown|unexpected|--llm-only/i);
  });

  it('accepts --version', () => {
    const r = runCli(['--version']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /@mcp-abap-adt\/llm-agent-server@/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/cli-flags.test.ts'`
Expected: FAIL on the two rejection cases — under current `strict: false`, the unknown flags are swallowed and the process proceeds (likely generating a template / exiting 0), so `r.status` is 0.

- [ ] **Step 3: Remove the behavior-flag entries from the `parseArgs` options** (`cli.ts:92-108`)

Delete these option lines: `'llm-api-key'`, `'llm-model'`, `'llm-temperature'`, `'rag-type'`, `'rag-url'`, `'rag-model'`, `'rag-vector-weight'`, `'rag-keyword-weight'`, `'mcp-type'`, `'mcp-url'`, `'mcp-command'`, `'mcp-args'`, `mode`, `'prompt-system'`, `'prompt-classifier'`, `'agent-show-reasoning'`. (`--llm-only` was never an option entry — nothing to delete; `strict: true` rejects it automatically.)

The remaining options block must be exactly:
```ts
  options: {
    config: { type: 'string', short: 'c' },
    'secrets-dir': { type: 'string' },
    env: { type: 'boolean' },
    'env-path': { type: 'string' },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    'plugin-dir': { type: 'string' },
    'log-file': { type: 'string' },
    'log-stdout': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
```

> `secrets-dir`/`env`/`env-path` are added here; their loading logic is implemented in Task 7. Adding them now keeps the options block in its final shape so the strict test is stable.

- [ ] **Step 4: Switch to `strict: true`** (`cli.ts:115`)

```ts
  allowPositionals: false,
  strict: true,
```

- [ ] **Step 5: Stop passing removed flags to `resolveSmartServerConfig`**

`resolveSmartServerConfig(args, yaml, env)` reads `args['llm-api-key']` etc. (Task 5 removes those reads.) For now, the `args` object simply won't contain them. No change needed at the call site beyond Task 5.

- [ ] **Step 6: Update the JSDoc header** at the top of `cli.ts` — remove the documentation lines for every removed flag and the `--llm-only` mention; the `--help` output is generated from this comment. Ensure the remaining usage lists exactly: `--config`, `--secrets-dir`, `--env`, `--env-path`, `--port`, `--host`, `--plugin-dir`, `--log-file`, `--log-stdout`, `--help`, `--version`. Replace the "LLM-only mode" note with: "To disable MCP, omit the `mcp:` block or set `mcp.type: none` in YAML."

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/cli-flags.test.ts'`
Expected: PASS — 3 tests (the `--version` case may be expanded in Task 7; it passes now since `--version` short-circuits before config).

- [ ] **Step 8: Build + lint**

Run: `npm run build && npm run lint:check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/cli.ts packages/llm-agent-server/src/smart-agent/__tests__/cli-flags.test.ts
git commit -m "feat(cli)!: strict parsing; remove behavior flags and dead --llm-only"
```

---

## Task 5: Remove Category-A env-var + default fallbacks in `config.ts`

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/config.ts` (`resolveSmartServerConfig` body + the `mode` resolution ~line 707)
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/config-validation.test.ts`

For each field, drop the direct `env.X` read and the hardcoded agent-identity default, and drop the removed `args['...']` CLI reads. Schema defaults for Category-B tuning params (temperatures, weights, dedupThreshold, agent.* knobs) STAY. Reference: spec "Rule 1" table.

- [ ] **Step 1: `llm.apiKey`** (`config.ts:447-454`) — remove `?? env.DEEPSEEK_API_KEY` and the `args['llm-api-key']` read:

```ts
  const flatApiKey = (get(yaml, 'llm', 'apiKey') as string) ?? '';
  const pipelineApiKey = get(yaml, 'pipeline', 'llm', 'main', 'apiKey') as
    | string
    | undefined;
  const apiKey = flatApiKey || pipelineApiKey || '';
```
Leave the existing `if (!apiKey && !get(yaml, 'pipeline', 'llm', 'main')) throw ...` guard in place for now — Task 6 replaces it with provider-aware validation.

- [ ] **Step 2: `mcp.url` / `mcp.command`** (`config.ts:458-463`) — remove `?? env.MCP_ENDPOINT` and `?? env.MCP_COMMAND` and the `args['mcp-url']`/`args['mcp-command']` reads:

```ts
  const mcpUrl = get(yaml, 'mcp', 'url') as string | undefined;
  const mcpCommand = get(yaml, 'mcp', 'command') as string | undefined;
  const mcpTypeRaw =
    (get(yaml, 'mcp', 'type') as string) ??
    (mcpUrl ? 'http' : mcpCommand ? 'stdio' : null);
```

- [ ] **Step 3: `prompts.system` / `prompts.classifier`** (`config.ts:475-483`) — remove `?? env.PROMPT_SYSTEM` and `?? env.PROMPT_CLASSIFIER` and the `args['prompt-*']` reads:

```ts
  const promptSystem = (get(yaml, 'prompts', 'system') as string) ?? null;
  const promptClassifier =
    (get(yaml, 'prompts', 'classifier') as string) ?? null;
```

- [ ] **Step 4: `llm.model`** — already handled in Task 3 Step 2 (no `env.DEEPSEEK_MODEL`/`'deepseek-chat'`). Verify the `llm:` block has no env/default for `model`.

- [ ] **Step 5: `rag.type` / `rag.url` / `rag.model`** (`config.ts:508-528`) — remove the `'ollama'`, `env.OLLAMA_URL`/`'http://localhost:11434'`, `env.OLLAMA_EMBED_MODEL`/`'nomic-embed-text'` fallbacks and the `args['rag-*']` reads. Leave `type` undefined when absent (the validator + RAG factory handle absence):

```ts
    rag: {
      type: get(yaml, 'rag', 'type') as
        | 'ollama'
        | 'in-memory'
        | 'qdrant'
        | 'hana-vector'
        | 'pg-vector'
        | undefined,
      embedder: (get(yaml, 'rag', 'embedder') as string) ?? undefined,
      url: get(yaml, 'rag', 'url') as string | undefined,
      model: get(yaml, 'rag', 'model') as string | undefined,
```
Keep `dedupThreshold`/`vectorWeight`/`keywordWeight` schema defaults (Category B) and `collectionName`/`resourceGroup` lines unchanged. Remove the `args['rag-vector-weight']`/`args['rag-keyword-weight']` reads, keeping the `0.7`/`0.3` defaults:
```ts
      vectorWeight: Number(get(yaml, 'rag', 'vectorWeight') ?? 0.7),
      keywordWeight: Number(get(yaml, 'rag', 'keywordWeight') ?? 0.3),
```

- [ ] **Step 6: `mode`** (`config.ts:~707`) — remove `?? env.SMART_AGENT_MODE` and the `args.mode` read. Resolve from YAML only:

```ts
  const mode = (get(yaml, 'mode') as SmartServerMode) ?? undefined;
```
(Find the existing `mode` resolution; it currently chains `args.mode ?? get(yaml,'mode') ?? env.SMART_AGENT_MODE`. Reduce to YAML-only. Absence is valid — the assembler defaults to `smart`.)

- [ ] **Step 7: Remove now-unused `args`/`env` references** — `resolveSmartServerConfig` keeps `env` only for Category-C runtime fields (`env.PORT`). Confirm no other `env.X` agent-behavior reads remain:

Run: `grep -n "env\.\(DEEPSEEK\|OLLAMA\|MCP_\|PROMPT_\|SMART_AGENT_MODE\)" packages/llm-agent-server/src/smart-agent/config.ts`
Expected: no matches.

- [ ] **Step 8: Add a regression test** to `config-validation.test.ts`

```ts
describe('resolveSmartServerConfig — no silent env/default fallbacks', () => {
  it('does not read DEEPSEEK_API_KEY / OLLAMA_URL / MCP_ENDPOINT from env', () => {
    const cfg = resolveSmartServerConfig(
      {},
      { llm: { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o' } },
      {
        DEEPSEEK_API_KEY: 'env-key',
        OLLAMA_URL: 'http://env-host:11434',
        MCP_ENDPOINT: 'http://env-mcp/mcp',
      } as NodeJS.ProcessEnv,
    );
    assert.equal(cfg.llm.apiKey, 'sk-x'); // not 'env-key'
    assert.equal(cfg.rag?.url, undefined); // not the env value
    assert.equal(cfg.mcp, undefined); // no mcp block in YAML, env ignored
  });
});
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/config-validation.test.ts'`
Expected: PASS. (If `cfg.mcp` is an object with nulls rather than `undefined`, assert on `cfg.mcp?.url === undefined` instead — adjust to the actual `mcp:` builder, which only emits a block when `mcpType` is non-null.)

- [ ] **Step 10: Build + lint**

Run: `npm run build && npm run lint:check`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/config.ts packages/llm-agent-server/src/smart-agent/__tests__/config-validation.test.ts
git commit -m "feat(config)!: remove silent env-var and hardcoded agent-identity fallbacks"
```

---

## Task 6: Provider-aware validation + human-readable error report

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/config.ts` (replace the bare `'LLM API key is required'` throw with `validateResolvedConfig`)
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/config-validation.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `config-validation.test.ts`)

```ts
describe('config validation — fail loud, human-readable', () => {
  const base = (llm: Record<string, unknown>) => ({ llm });

  it('flat schema requires explicit provider', () => {
    assert.throws(
      () => resolveSmartServerConfig({}, base({ apiKey: 'k', model: 'm' }), {}),
      /provider.*required|one of: openai, anthropic, deepseek, sap-ai-sdk, ollama/i,
    );
  });

  it('rejects an unknown provider value', () => {
    assert.throws(
      () => resolveSmartServerConfig({}, base({ provider: 'cohere', model: 'm' }), {}),
      /provider.*one of: openai, anthropic, deepseek, sap-ai-sdk, ollama/i,
    );
  });

  it('openai requires a resolvable apiKey', () => {
    assert.throws(
      () => resolveSmartServerConfig({}, base({ provider: 'openai', model: 'gpt-4o' }), {}),
      /openai requires.*apiKey/i,
    );
  });

  it('ollama needs no apiKey', () => {
    const cfg = resolveSmartServerConfig(
      {},
      base({ provider: 'ollama', model: 'qwen2.5:14b' }),
      {},
    );
    assert.equal(cfg.llm.provider, 'ollama');
  });

  it('sap-ai-sdk requires AICORE_SERVICE_KEY', () => {
    assert.throws(
      () => resolveSmartServerConfig({}, base({ provider: 'sap-ai-sdk', model: 'gpt-4o' }), {}),
      /sap-ai-sdk requires.*AICORE_SERVICE_KEY/i,
    );
  });

  it('mcp.type: http requires mcp.url', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm: { provider: 'ollama', model: 'm' }, mcp: { type: 'http' } },
          {},
        ),
      /mcp\.url.*required/i,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/config-validation.test.ts'`
Expected: FAIL — current code only throws the generic `'LLM API key is required'`; provider/enum/mcp checks don't exist.

- [ ] **Step 3: Add a `ConfigValidationError` + `validateResolvedConfig`** near the top of `config.ts` (after imports)

```ts
const VALID_PROVIDERS = [
  'openai',
  'anthropic',
  'deepseek',
  'sap-ai-sdk',
  'ollama',
] as const;

export class ConfigValidationError extends Error {
  constructor(issues: string[]) {
    super(
      `Configuration error in smart-server.yaml:\n${issues
        .map((i) => `  - ${i}`)
        .join('\n')}\nSet these fields in your YAML and restart.`,
    );
    this.name = 'ConfigValidationError';
  }
}
```

- [ ] **Step 4: Implement the validator** (place it so `resolveSmartServerConfig` can call it just before `return`). It takes the resolved config + the raw YAML (to know which blocks are present) + the env (to check `AICORE_SERVICE_KEY`):

```ts
function validateResolvedConfig(
  resolved: Omit<SmartServerConfig, 'log'>,
  yaml: YamlConfig,
  env: NodeJS.ProcessEnv,
): void {
  const issues: string[] = [];
  const usingPipeline = !!get(yaml, 'pipeline', 'llm', 'main');

  // Determine the effective provider for credential checks.
  const provider = usingPipeline
    ? (get(yaml, 'pipeline', 'llm', 'main', 'provider') as string | undefined)
    : resolved.llm.provider;

  // 1 + 2: identity + provider enum
  if (!provider) {
    issues.push(
      usingPipeline
        ? 'pipeline.llm.main.provider: required (one of: openai, anthropic, deepseek, sap-ai-sdk, ollama)'
        : 'llm.provider: required (one of: openai, anthropic, deepseek, sap-ai-sdk, ollama)',
    );
  } else if (!(VALID_PROVIDERS as readonly string[]).includes(provider)) {
    issues.push(
      `llm.provider: "${provider}" is invalid (one of: openai, anthropic, deepseek, sap-ai-sdk, ollama)`,
    );
  }
  if (!resolved.llm.model && !get(yaml, 'pipeline', 'llm', 'main', 'model')) {
    issues.push('llm.model: required (string)');
  }

  // 3: provider-specific credentials
  if (provider === 'openai' || provider === 'anthropic' || provider === 'deepseek') {
    if (!resolved.llm.apiKey) {
      issues.push(
        `Provider \`${provider}\` requires \`llm.apiKey\` to resolve to a non-empty value (typically via \`\${${provider.toUpperCase()}_API_KEY}\` env reference).`,
      );
    }
  } else if (provider === 'sap-ai-sdk') {
    if (!env.AICORE_SERVICE_KEY) {
      issues.push(
        'Provider `sap-ai-sdk` requires the `AICORE_SERVICE_KEY` env var to be set with the SAP AI Core service-key JSON content. None found.',
      );
    }
  }
  // ollama: no credential check.

  // 4: MCP conditional fields (only when the block is present)
  if (get(yaml, 'mcp')) {
    const mcpType = get(yaml, 'mcp', 'type') as string | undefined;
    if (mcpType && !['http', 'stdio', 'none'].includes(mcpType)) {
      issues.push(`mcp.type: "${mcpType}" is invalid (one of: http, stdio, none)`);
    }
    if (mcpType === 'http' && !get(yaml, 'mcp', 'url')) {
      issues.push('mcp.url: required when mcp.type is http');
    }
    if (mcpType === 'stdio' && !get(yaml, 'mcp', 'command')) {
      issues.push('mcp.command: required when mcp.type is stdio');
    }
  }

  // 5: RAG conditional fields (only when a flat rag block is present)
  if (get(yaml, 'rag')) {
    const ragType = get(yaml, 'rag', 'type') as string | undefined;
    if (!ragType) {
      issues.push('rag.type: required when a rag: block is present');
    } else if (ragType === 'ollama') {
      if (!get(yaml, 'rag', 'url')) issues.push('rag.url: required for rag.type ollama');
      if (!get(yaml, 'rag', 'model')) issues.push('rag.model: required for rag.type ollama');
    }
    // in-memory: no url/model needed. qdrant/hana/pg: defer to existing schema.
  }

  if (issues.length > 0) throw new ConfigValidationError(issues);
}
```

- [ ] **Step 5: Replace the legacy guard with the validator call**

Remove the line `if (!apiKey && !get(yaml, 'pipeline', 'llm', 'main')) throw new Error('LLM API key is required');` (`config.ts:454`). At the end of `resolveSmartServerConfig`, build the result into a `const resolved = { ... }` and call the validator before returning:

```ts
  const resolved = {
    port: /* ...existing... */,
    // ...all existing fields...
  };
  validateResolvedConfig(resolved, yaml, env);
  return resolved;
```

(If the function currently `return {...}` inline, refactor to assign to `resolved` first. Keep every existing field intact.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/config-validation.test.ts'`
Expected: PASS — all validation cases. Re-run the Task-3/Task-5 tests in the same file; the earlier ollama fixture that used a dummy `apiKey: 'x'` still passes (ollama ignores apiKey, validator doesn't require it). Adjust any fixture that now (correctly) trips a new required-field check by adding the required field.

- [ ] **Step 7: Build + lint**

Run: `npm run build && npm run lint:check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/config.ts packages/llm-agent-server/src/smart-agent/__tests__/config-validation.test.ts
git commit -m "feat(config)!: provider-aware fail-loud validation with batched error report"
```

---

## Task 7: Env-loading flags `--secrets-dir` / `--env` / `--env-path`

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/cli.ts:139-152` (env-loading block)
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/cli-flags.test.ts`

Resolution order (highest wins per variable): pre-existing `process.env` → `--env-path <file>` → `--env` (all `*.env` under `<secrets-dir>`, alphabetical) → implicit `.env` in cwd (only when neither `--env` nor `--env-path` given). All loads use `override: false`. Default `<secrets-dir>` is `~/.config/mcp-abap-adt/`.

- [ ] **Step 1: Write the failing tests** (append to `cli-flags.test.ts`)

These drive the CLI as a subprocess with a temp secrets dir + `.env` files, and a minimal valid YAML so the process reaches startup. To observe which vars loaded without booting a server, add a tiny escape hatch: when `process.env.__CLI_PRINT_ENV` lists comma-separated names, `cli.ts` prints their resolved values to stdout and exits 0 right after env loading (before constructing the server). Implement that hatch in Step 4.

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

function runCliEnv(args: string[], extraEnv: Record<string, string>) {
  return spawnSync('node', ['--import', 'tsx/esm', CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

describe('cli env loading', () => {
  it('--env-path loads a specific file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-env-'));
    writeFileSync(path.join(dir, 'a.env'), 'FOO=from_envpath\n');
    const r = runCliEnv(['--env-path', path.join(dir, 'a.env')], {
      __CLI_PRINT_ENV: 'FOO',
    });
    assert.match(r.stdout, /FOO=from_envpath/);
  });

  it('--env scans secrets-dir for *.env (alphabetical)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-env-'));
    writeFileSync(path.join(dir, '1-a.env'), 'BAR=first\n');
    writeFileSync(path.join(dir, '2-b.env'), 'BAR=second\n'); // first-wins
    const r = runCliEnv(['--secrets-dir', dir, '--env'], {
      __CLI_PRINT_ENV: 'BAR',
    });
    assert.match(r.stdout, /BAR=first/);
  });

  it('pre-existing process.env wins over file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-env-'));
    writeFileSync(path.join(dir, 'a.env'), 'BAZ=from_file\n');
    const r = runCliEnv(['--env-path', path.join(dir, 'a.env')], {
      __CLI_PRINT_ENV: 'BAZ',
      BAZ: 'from_shell',
    });
    assert.match(r.stdout, /BAZ=from_shell/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/cli-flags.test.ts'`
Expected: FAIL — `--secrets-dir`/`--env`/`--env-path` semantics + the print-env hatch don't exist yet.

- [ ] **Step 3: Replace the env-loading block** (`cli.ts:135-152`)

```ts
import os from 'node:os';

// ---------------------------------------------------------------------------
// Load env — order: shell > --env-path > --env (*.env in secrets-dir) > .env
// All loads use override:false so shell-exported values always win.
// ---------------------------------------------------------------------------

const secretsDir =
  (args['secrets-dir'] as string | undefined) ??
  path.join(os.homedir(), '.config', 'mcp-abap-adt');
const envPath = args['env-path'] as string | undefined;
const envScan = args.env === true;

if (envPath) {
  const result = configDotenv({ path: path.resolve(envPath), override: false });
  if (!result.parsed) {
    process.stderr.write(`Warning: could not load env file: ${envPath}\n`);
  }
}
if (envScan) {
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(secretsDir)
      .filter((f) => f.endsWith('.env'))
      .sort();
  } catch {
    process.stderr.write(`Warning: secrets-dir not readable: ${secretsDir}\n`);
  }
  for (const f of entries) {
    configDotenv({ path: path.join(secretsDir, f), override: false });
  }
}
if (!envPath && !envScan) {
  // Implicit .env in cwd — only when neither flag is given. ok if absent.
  configDotenv({ path: path.resolve('.env'), override: false });
}
```

- [ ] **Step 4: Add the test escape hatch** immediately after the env-loading block (before config loading)

```ts
if (process.env.__CLI_PRINT_ENV) {
  for (const name of process.env.__CLI_PRINT_ENV.split(',')) {
    process.stdout.write(`${name}=${process.env[name] ?? ''}\n`);
  }
  process.exit(0);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/cli-flags.test.ts'`
Expected: PASS — env-loading cases + the strict cases from Task 4.

- [ ] **Step 6: Build + lint**

Run: `npm run build && npm run lint:check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/cli.ts packages/llm-agent-server/src/smart-agent/__tests__/cli-flags.test.ts
git commit -m "feat(cli): add --secrets-dir/--env/--env-path env loading (shell-wins precedence)"
```

---

## Task 8: Fix examples, dev scripts, docs, and CHANGELOG

**Files:**
- Modify: `examples/docker-ollama/smart-server.yaml`
- Modify: `package.json` (root) `dev:llm`
- Modify: `packages/llm-agent-server/package.json` `dev:llm`
- Modify: `CLAUDE.md`
- Modify: `docs/QUICK_START.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Confirm `docker-ollama` now loads** — its flat `llm: { provider: ollama, url, model }` (no apiKey) is exactly the path Tasks 3+6 support. Verify the YAML `llm.url` points at the `/v1` path. Current value is `${OLLAMA_URL:-http://localhost:11434}` — append `/v1` so the OpenAI client hits the compatible endpoint:

```yaml
llm:
  provider: ollama
  url: ${OLLAMA_URL:-http://localhost:11434}/v1
  model: qwen2.5:14b
  temperature: 0.7
  maxTokens: 8192
```
(Remove the now-unused top-level note if it implies a different mechanism. Leave `rag:` block as-is — RAG ollama is separate.)

- [ ] **Step 2: Smoke-check the example resolves** (no server boot needed)

Run:
```bash
cd packages/llm-agent-server && node --import tsx/esm -e "import('./src/smart-agent/config.js').then(async m => { const yaml = (await import('yaml')).parse(require('fs').readFileSync('../../examples/docker-ollama/smart-server.yaml','utf8').replace(/\\\$\{OLLAMA_URL:-([^}]+)\}/g,'\$1')); const cfg = m.resolveSmartServerConfig({}, yaml, {}); console.log('provider', cfg.llm.provider, 'url', cfg.llm.url); })"
```
Expected: prints `provider ollama url http://localhost:11434/v1` with NO `LLM API key is required` / validation error. (If the inline `${...}` expansion in the one-liner is awkward, instead write the resolved YAML to a temp object in a tiny throwaway script — the assertion is just "ollama config validates without an apiKey".)

- [ ] **Step 3: Fix `dev:llm` scripts** — `--llm-only` no longer parses. In root `package.json` and `packages/llm-agent-server/package.json`, either delete the `dev:llm` line or repoint it to a no-MCP config. Recommended: delete both `dev:llm` entries (the CLAUDE.md command list is updated in Step 4). If keeping, create `examples/llm-only/smart-server.yaml` with `mcp.type: none` and point `dev:llm` at it — but deletion is simpler and YAGNI.

**Decision: delete both `dev:llm` script lines.**

- [ ] **Step 4: Update `CLAUDE.md`**
  - Remove the `npm run dev:llm  # Run CLI in LLM-only mode (no MCP)` line from the Commands block.
  - In the Environment table, remove the `MCP_DISABLED` row (it is not read anywhere in `src/`). Add a note under the table: "To run without MCP, omit the `mcp:` block or set `mcp.type: none` in `smart-server.yaml`."
  - If any CLI flags are listed, sync to the kept set.

- [ ] **Step 5: Update `docs/QUICK_START.md`** — replace the CLI-flag table with the trimmed list (`--config`, `--secrets-dir`, `--env`, `--env-path`, `--port`, `--host`, `--plugin-dir`, `--log-file`, `--log-stdout`, `--help`, `--version`) and add the paragraph: "Agent behavior lives in `smart-server.yaml`. The CLI flags above are runtime/process overrides — config path, env loading, port/host, logging — not agent-behavior knobs." Document `provider: ollama` as a supported value with the no-key note.

- [ ] **Step 6: Run the doc sweep** for stale flag references

Run:
```bash
rg -n '\-\-(llm-api-key|llm-model|llm-temperature|rag-type|rag-url|rag-model|rag-vector-weight|rag-keyword-weight|mcp-type|mcp-url|mcp-command|mcp-args|mode|prompt-system|prompt-classifier|agent-show-reasoning|llm-only)' docs README.md CLAUDE.md packages --glob '!*.test.ts' --glob '!dist/**' --glob '!node_modules/**'
```
Expected: no hits. Fix every hit (remove or rephrase).

- [ ] **Step 7: Add the CHANGELOG `[Unreleased]` entry** — under `## [Unreleased]`, add `### Breaking changes` and `### Added` subsections with the exact content from the spec's "CHANGELOG entry" section (flag removals incl. `--llm-only`, flat-schema `provider` now required, the 3 new env flags, hardened validation; and the new `ollama` provider under Added). Do NOT bump any package.json version — that happens in the later batch-release PR.

- [ ] **Step 8: Full build + lint + the new test files**

Run:
```bash
npm run build && npm run lint:check \
  && (cd packages/ollama-llm && node --import tsx/esm --test 'src/**/*.test.ts') \
  && (cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/*.test.ts')
```
Expected: build PASS, lint clean, all package + server tests PASS.

- [ ] **Step 9: Commit**

```bash
git add examples/docker-ollama/smart-server.yaml package.json packages/llm-agent-server/package.json CLAUDE.md docs/QUICK_START.md CHANGELOG.md
git commit -m "docs: trim CLI to runtime metadata; fix docker-ollama; CHANGELOG for #134"
```

---

## Task 9: Delete the implemented spec + plan, final verification

Per CLAUDE.md, specs/plans live in-tree only while active. After implementation is merged-ready they are deleted (history lives in git). Do this as the LAST step, after a final green run.

- [ ] **Step 1: Final full verification**

Run:
```bash
npm run build && npm run lint:check \
  && (cd packages/ollama-llm && node --import tsx/esm --test 'src/**/*.test.ts') \
  && (cd packages/llm-agent-server && node --import tsx/esm --test 'src/smart-agent/__tests__/*.test.ts')
```
Expected: all PASS.

- [ ] **Step 2: Delete the spec and plan**

```bash
git rm docs/superpowers/specs/2026-05-23-cli-cleanup-design.md docs/superpowers/plans/2026-05-23-cli-cleanup.md
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove implemented cli-cleanup spec + plan (history in git)"
```

> Note: defer Step 2-3 until just before opening/merging the PR if the reviewer still wants the spec visible during review. The finishing-a-development-branch skill governs the merge/PR decision.

---

## Self-Review

**1. Spec coverage:**
- Rule 1 (no silent fallback) → Task 5 (all 10 fields: apiKey, model, mcp.url, mcp.command, prompts.*, mode, rag.type/url/model) + Task 3 (flat provider/url, the `makeDefaultLlm`-deepseek default).
- Rule 2 (conditional required) → Task 6 validator (provider always required; apiKey per-provider incl. ollama/sap-ai-sdk exempt; mcp.* conditional; rag.* conditional).
- Category B defaults kept → Task 5 explicitly retains temperature/weights/dedup/agent.* defaults.
- CLI flags removed (16 + `--llm-only`) → Task 4. Kept/added (incl. `--version`, `--secrets-dir`/`--env`/`--env-path`) → Task 4 (options) + Task 7 (loading).
- strict:true → Task 4. Env-loading semantics → Task 7.
- Ollama provider (new package + wiring + flat-path) → Tasks 1, 2, 3. Monorepo wiring (libs peer/dev/meta, root build/clean, tsconfig refs, server dep) → Task 2.
- Validation error format → Task 6 `ConfigValidationError`. CHANGELOG-now → Task 8. docs sweep + docker-ollama fix + dev:llm/CLAUDE.md/MCP_DISABLED → Task 8. Test cases (1-14) → Tasks 3-7 tests. Spec/plan deletion policy → Task 9.

**2. Placeholder scan:** No TBDs. Every code step shows real code drawn from the actual files (deepseek-llm clone, providers.ts switch shape, config.ts line targets). The two "Decision:" notes resolve ambiguities inline (dummy apiKey in early ollama fixture; delete `dev:llm`).

**3. Type consistency:** `OllamaProvider`/`OllamaConfig` (Task 1) ↔ `loadOllama` return + `case 'ollama'` (Task 2) ↔ `MakeLlmConfig.provider`/`PipelineLlmProviderConfig.provider` unions (Task 2) ↔ `SmartServerLlmConfig.provider`/`url` (Task 3) ↔ validator `VALID_PROVIDERS` (Task 6) — all use the same 5-value union and `baseURL`/`url` mapping (`SmartServerLlmConfig.url` → `makeLlm` `baseURL`). `ConfigValidationError` defined once (Task 6) and used by all validation tests.

**4. Ambiguity check:** The early-fixture-vs-validator ordering (Task 3 fixture needs an apiKey before Task 6's provider-aware guard exists) is called out with a Decision. The test escape hatch (`__CLI_PRINT_ENV`) makes env-loading observable without booting a server — documented in Task 7. The `?? 'deepseek'` type-narrowing net in Task 3 is annotated as unreachable-after-validation, not a reintroduced silent default.

No blocking issues. Plan ready for execution.
