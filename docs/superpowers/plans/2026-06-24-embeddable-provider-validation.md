# Skip Provider-Runtime Validation When Providers Are Injected — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `ControllerSkillPipelineBuilder.build(deps)` skip the credential (`apiKey`/`AICORE_SERVICE_KEY`) and `model`-required validation when the consumer injects BOTH `makeLlm` and `embedder` — structural validation and the server path stay unchanged.

**Architecture:** Add `skipProviderRuntimeChecks?: boolean` to `ResolveSmartServerConfigOptions`, thread it through `validateResolvedConfig` → `checkLlmRole`/`checkRagStore` (skip credential + model issues only). The builder sets it when both providers are injected.

**Tech Stack:** TypeScript (ESM, strict), `node:test` + `tsx`, Biome. Package: `@mcp-abap-adt/llm-agent-server-libs`.

**Spec:** `docs/superpowers/specs/2026-06-24-embeddable-provider-validation-design.md`

---

## File Structure

- **Modify** `packages/llm-agent-server-libs/src/smart-agent/config.ts` — option + threading through `validateResolvedConfig`/`checkLlmRole`/`checkRagStore`.
- **Test** `packages/llm-agent-server-libs/src/smart-agent/config.test.ts` (or the existing config test file) — the 3 unit cases.
- **Modify** `packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.ts` — compute + pass the flag in `build()`.
- **Modify** `packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts` — drop the dummy-env + explicit-model workarounds; add the both-injected-no-creds test.

### Conventions
- ESM `.js` imports; Biome (`npm run lint`). Tests: `node --import tsx/esm --test --test-reporter=spec <file>`; package suite `npm -w @mcp-abap-adt/llm-agent-server-libs run test`.
- First READ `config.ts` lines ~430-720 (`ResolveSmartServerConfigOptions`, `resolveSmartServerConfig`, `validateResolvedConfig`, `checkLlmRole`, `checkRagStore`) and confirm exact names/signatures before editing.

---

## Task 1: `config.ts` — skippable provider-runtime checks

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/config.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `config.test.ts` (match the file's existing import of `resolveSmartServerConfig`; if it's a different test file for config, use that — confirm by grep). Use the map-or-flat `llm` shape the validator actually reads from the raw `yaml` arg (the 2nd param):

```ts
test('skipProviderRuntimeChecks: sap-ai-sdk with no AICORE_SERVICE_KEY + no models does not throw', () => {
  const yaml = {
    llm: { main: { provider: 'sap-ai-sdk' } },           // no model
    pipeline: { name: 'controller', config: { subagents: {
      evaluator: { provider: 'sap-ai-sdk' },
      planner: { provider: 'sap-ai-sdk' },
      executor: { provider: 'sap-ai-sdk' },
    } } },
    rag: { type: 'in-memory', embedder: 'sap-ai-core' },  // no model
  };
  assert.doesNotThrow(() =>
    resolveSmartServerConfig({}, yaml as any, {} /* empty env: no AICORE_SERVICE_KEY */, {
      skipProviderRuntimeChecks: true,
    }),
  );
});

test('WITHOUT the flag, the same config throws (server path unchanged)', () => {
  const yaml = {
    llm: { main: { provider: 'sap-ai-sdk' } },
    rag: { type: 'in-memory', embedder: 'sap-ai-core' },
  };
  assert.throws(
    () => resolveSmartServerConfig({}, yaml as any, {}, {}),
    /AICORE_SERVICE_KEY|model/,
  );
});

test('skipProviderRuntimeChecks still enforces STRUCTURAL validation', () => {
  const yaml = {
    llm: { main: { provider: 'bogus-provider' } },
    rag: { type: 'in-memory' },
  };
  assert.throws(
    () => resolveSmartServerConfig({}, yaml as any, {}, { skipProviderRuntimeChecks: true }),
    /provider.*invalid|invalid.*provider/i,
  );
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/smart-agent/config.test.ts
```
Expected: FAIL — `skipProviderRuntimeChecks` is not accepted / not honoured (the first test throws on AICORE).

- [ ] **Step 3: Add the option + thread it**

In `config.ts`:

1. Add the field to `ResolveSmartServerConfigOptions` (find the interface; add):
```ts
  /** When true, SKIP provider-runtime validation — credential checks
   *  (apiKey / AICORE_SERVICE_KEY) and `*.model` required — keeping STRUCTURAL
   *  checks (provider name, rag type, url/collectionName, pipeline name,
   *  embedder blocklist). Set by embeddable callers that inject their own
   *  `makeLlm` + `embedder`, so the default provider's creds/model are unused.
   *  Default false → server behaviour unchanged. */
  skipProviderRuntimeChecks?: boolean;
```

2. `checkLlmRole` — add a param and gate the credential + model checks:
```ts
function checkLlmRole(
  label: string,
  role: { provider?: unknown; apiKey?: unknown; model?: unknown } | undefined,
  requireModel: boolean,
  env: NodeJS.ProcessEnv,
  issues: string[],
  skipRuntime = false,           // <-- NEW
): void {
  const provider = role?.provider as string | undefined;
  if (!provider) { issues.push(`${label}.provider: required ...`); return; }
  if (!(VALID_PROVIDERS as readonly string[]).includes(provider)) {
    issues.push(`${label}.provider: "${provider}" is invalid ...`); return;
  }
  if (skipRuntime) return;        // <-- structural done; skip model + creds
  if (requireModel && !role?.model) { issues.push(`${label}.model: required (string)`); }
  if (provider === 'openai' || provider === 'anthropic' || provider === 'deepseek') {
    if (!role?.apiKey) { issues.push(`${provider} requires ${label}.apiKey ...`); }
  } else if (provider === 'sap-ai-sdk') {
    if (!env.AICORE_SERVICE_KEY) { issues.push('sap-ai-sdk requires the AICORE_SERVICE_KEY ...'); }
  }
}
```
(Keep the EXISTING issue message strings verbatim — only add the `skipRuntime` param + the early `return`.)

3. `validateLlmEntry` — thread `skipRuntime` through to `checkLlmRole`:
```ts
function validateLlmEntry(label, cfg, required, env, issues, skipRuntime = false): void {
  checkLlmRole(label, cfg, required, env, issues, skipRuntime);
}
```

4. `checkRagStore` — add a `skipRuntime` param and gate ONLY the model-required check:
```ts
function checkRagStore(label, store, issues, skipRuntime = false): void {
  // ... type / url / collectionName / blocklist checks UNCHANGED ...
  const usesEmbedder = /* unchanged */;
  if (!skipRuntime && usesEmbedder && !store.model) {
    issues.push(`${label}.model: required when an embedder is used ...`);
  }
}
```

5. `validateResolvedConfig` — accept an options arg and pass `skipRuntime` to every `validateLlmEntry` + the `checkRagStore` call:
```ts
function validateResolvedConfig(
  _resolved: Omit<SmartServerConfig, 'log'>,
  yaml: YamlConfig,
  env: NodeJS.ProcessEnv,
  opts: { skipProviderRuntimeChecks?: boolean } = {},
): void {
  const skip = opts.skipProviderRuntimeChecks === true;
  // ... in EVERY validateLlmEntry(...) call, pass `skip` as the last arg ...
  // ... find the checkRagStore(...) call(s) and pass `skip` ...
}
```
(Find ALL `validateLlmEntry(` and `checkRagStore(` call sites in `validateResolvedConfig` and thread `skip`.)

6. `resolveSmartServerConfig` — at its `validateResolvedConfig(resolved, yaml, env)` call (~:1181), pass the option:
```ts
validateResolvedConfig(resolved, yaml, env, {
  skipProviderRuntimeChecks: options.skipProviderRuntimeChecks,
});
```
(`options` is the 4th param `ResolveSmartServerConfigOptions`; confirm its local name.)

- [ ] **Step 4: Run tests + build, verify PASS**

```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/smart-agent/config.test.ts
npm -w @mcp-abap-adt/llm-agent-server-libs run build
```
Expected: 3 new tests pass; build clean.

- [ ] **Step 5: Full suite (server path unchanged)**

```bash
npm -w @mcp-abap-adt/llm-agent-server-libs run test 2>&1 | tail -8
```
0 fail vs baseline; existing config validation tests (which assert credential/model errors WITHOUT the flag) still pass — proves the default path is unchanged.

- [ ] **Step 6: Commit**

```bash
npm run lint
git add packages/llm-agent-server-libs/src/smart-agent/config.ts \
        packages/llm-agent-server-libs/src/smart-agent/config.test.ts
git commit -m "feat(config): skipProviderRuntimeChecks option — skip credential/model validation, keep structural"
```

---

## Task 2: builder opts in + drop the test workarounds

**Files:**
- Modify: `packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.ts`
- Test: `packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts`

- [ ] **Step 1: Write/adjust the failing test**

In `controller-skill-pipeline-builder.test.ts`:
1. REMOVE the dummy `process.env.AICORE_SERVICE_KEY ??= ...` line added earlier (the whole point is no longer needing it).
2. From the existing `build(deps) ... no I/O` test and the prebuilt-skillHost test, REMOVE the explicit `model:` that was only added to satisfy validation — leave a `withEmbedder({ provider: 'sap-ai-core' })` (no model) and `withLlm({ provider: 'sap-ai-sdk' })` (no model) to prove the skip works.
3. Add a focused test:
```ts
test('build({makeLlm,embedder}) needs no AICORE_SERVICE_KEY and no models (provider-runtime checks skipped)', async () => {
  const prev = process.env.AICORE_SERVICE_KEY;
  delete process.env.AICORE_SERVICE_KEY;            // prove it is NOT required
  try {
    const cannedLlm = { chat: async () => ({ ok: true, value: { content: '', toolCalls: [] } }), model: 'stub' }
      as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
    const { close } = await new ControllerSkillPipelineBuilder()
      .withLlm({ provider: 'sap-ai-sdk' })           // no model
      .withSkillSource({ github: 'a/b', enabled: ['sap-abap'], collection: 'sap' })
      .withEmbedder({ provider: 'sap-ai-core' })     // no model
      .build({
        makeLlm: async () => cannedLlm,
        embedder: { embed: async () => ({ vector: [0] }) } as unknown as import('@mcp-abap-adt/llm-agent').IEmbedder,
        buildSkillHost: async () => ({ rag: () => ({ query: async () => [], activeManifest: async () => ({}) }), groups: () => [{ group: 'sap' }], load: async () => {} } as unknown as import('@mcp-abap-adt/llm-agent').ISkillPluginHost),
        connectMcp: async () => [],
      });
    await close();
  } finally {
    if (prev !== undefined) process.env.AICORE_SERVICE_KEY = prev;
  }
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts
```
Expected: the new test (and the model-less existing tests) FAIL with the AICORE/model validation errors — because `build()` does not yet pass the skip flag.

- [ ] **Step 3: Pass the flag from `build()`**

In `controller-skill-pipeline-builder.ts` `build(deps?)`:
```ts
  async build(deps?: BuildAgentDeps): Promise<{ agent: ISmartAgent; close: () => Promise<void> }> {
    // When the consumer injects BOTH the LLM factory and the embedder, the real
    // provider/credentials/model are never used — skip provider-runtime config
    // validation (keep structural). Otherwise validate normally.
    const skipProviderRuntimeChecks = !!(deps?.makeLlm && deps?.embedder);
    const normalized = resolveSmartServerConfig(
      {},
      this.toConfig() as YamlConfig,
      process.env,
      { skipProviderRuntimeChecks },
    );
    const mergedDeps: BuildAgentDeps | undefined =
      this._mcpClients || deps
        ? { ...(this._mcpClients ? { mcpClients: this._mcpClients } : {}), ...deps }
        : undefined;
    return buildAgent(normalized as SmartServerConfig, mergedDeps);
  }
```

- [ ] **Step 4: Run tests + build, verify PASS**

```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts
npm -w @mcp-abap-adt/llm-agent-server-libs run build
```
Expected: all builder tests pass (incl. the new no-creds/no-model test); build clean. Confirm the `toConfig()` translation tests are unaffected (they don't call `build()`).

- [ ] **Step 5: Full gate + commit**

```bash
npm test && npm run lint:check && npm run build
git add packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.ts \
        packages/llm-agent-server-libs/src/builders/controller-skill-pipeline-builder.test.ts
git commit -m "feat(builders): build() skips provider-runtime validation when makeLlm+embedder injected"
```
Expected: all green.

---

## Self-Review

**1. Spec coverage:**
- `skipProviderRuntimeChecks` option + threading → Task 1. ✓
- Structural checks always run; only credential+model skipped → Task 1 Step 3 (early `return` after provider-name check; `checkRagStore` gates only the model line) + the structural test. ✓
- Server path unchanged → Task 1 Step 5 (default-false, existing tests pass). ✓
- Builder gates on both `makeLlm`+`embedder` injected → Task 2 Step 3. ✓
- Remove test workarounds (dummy env + explicit models) → Task 2 Step 1. ✓
- both-injected-no-creds test + single-injected-still-validates is implicit (existing tests that inject both now drop models; a non-injected path is the server tests). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows code; commands have expected output. The "find all call sites" instructions are explicit reading tasks, not placeholders.

**3. Type consistency:** `skipProviderRuntimeChecks` (option) / `skipRuntime` (the internal param threaded into `checkLlmRole`/`validateLlmEntry`/`checkRagStore`) names are used consistently; `resolveSmartServerConfig`'s options arg is the existing `ResolveSmartServerConfigOptions`.
