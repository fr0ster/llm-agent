# Skip Provider-Runtime Validation When Providers Are Injected — Design

**Date:** 2026-06-24
**Status:** Approved (design); pending spec review → plan.

## Problem

`resolveSmartServerConfig` runs `validateResolvedConfig` UNCONDITIONALLY. That
validator mixes two concerns:

- **Structural** — provider name in the allowed set, `rag.type` valid,
  `qdrant.url` / `hana|pg.collectionName` present, `pipeline.name` present, the
  embedder blocklist (deepseek/anthropic have no embedder).
- **Provider-runtime** — `apiKey` (openai/anthropic/deepseek) /
  `AICORE_SERVICE_KEY` (sap-ai-sdk) present, and `*.model` required (LLM roles +
  any embedding store).

`ControllerSkillPipelineBuilder.build(deps)` calls `resolveSmartServerConfig`. On
the embeddable path a consumer injects their own `makeLlm` + `embedder` via
`BuildAgentDeps`, so the real provider, its credentials, and the config `model`
strings are never used. Yet the unconditional validator still demands
`AICORE_SERVICE_KEY` (for `sap-ai-sdk`) and `*.model`. The builder's tests had to
work around this with a dummy `process.env.AICORE_SERVICE_KEY` and explicit model
strings. This contradicts the library's dependency-injection philosophy: when the
consumer supplies the implementation, the library must not demand the default
provider's credentials.

## Approach

Split the validation **by concern** and make ONLY the provider-runtime checks
skippable; structural checks always run. The builder opts in to skipping when —
and only when — it can prove the real providers are unused.

### Component 1 — `config.ts` skippable provider-runtime checks

- Add `skipProviderRuntimeChecks?: boolean` to the existing
  `ResolveSmartServerConfigOptions`. Default `undefined`/`false`.
- Thread it from `resolveSmartServerConfig` into `validateResolvedConfig`, then
  into `checkLlmRole` and `checkRagStore`:
  - `checkLlmRole`: when the flag is set, **skip** the `apiKey` /
    `AICORE_SERVICE_KEY` credential check AND force `requireModel = false`. The
    provider-name validity check STILL runs.
  - `checkRagStore`: when the flag is set, **skip** the "model required when an
    embedder is used" check. The `type`/`url`/`collectionName`/blocklist checks
    STILL run.
- Everything else in `validateResolvedConfig` (pipeline name, etc.) is unchanged.
- `SmartServer.start()` and every existing caller pass no flag → **behaviour
  preserved** (server still enforces credentials + models).

### Component 2 — builder opts in when providers are injected

In `ControllerSkillPipelineBuilder.build(deps?)`:

```ts
const skipProviderRuntimeChecks = !!(deps?.makeLlm && deps?.embedder);
const normalized = resolveSmartServerConfig({}, this.toConfig() as YamlConfig,
  process.env, { skipProviderRuntimeChecks });
```

Gate on **both** `makeLlm` AND `embedder` injected: only then are BOTH the LLM
roles' and the embedder's runtime concerns moot. If only one (or neither) is
injected, the real provider for the other is used, so its credentials/model must
still be validated → do not skip.

## Data flow

`.build(deps)` → compute `skipProviderRuntimeChecks` from `deps` →
`resolveSmartServerConfig(..., { skipProviderRuntimeChecks })` →
`validateResolvedConfig(resolved, yaml, env, { skipProviderRuntimeChecks })` →
`checkLlmRole` / `checkRagStore` skip credential+model issues but keep structural
ones → normalized config → `buildAgent`.

## Error handling

- Structural errors (bad provider name, invalid rag type, missing pipeline name,
  qdrant without url) STILL throw on the injected path — a typo is still caught.
- With the flag set + both providers injected, a config that omits
  `AICORE_SERVICE_KEY` / `model` builds successfully.
- Server path unchanged: missing credentials/models still fail loud.

## Testing

**Unit (`config.ts`):**
- `resolveSmartServerConfig` with `skipProviderRuntimeChecks: true` + a
  `sap-ai-sdk` LLM and NO `AICORE_SERVICE_KEY` and NO models → no throw.
- Same config WITHOUT the flag → throws (AICORE + model issues) — proves the
  default/server path is unchanged.
- With the flag set, a STRUCTURAL error (e.g. `provider: 'bogus'` or
  `rag.type: 'nonsense'`) STILL throws — proves only runtime checks are skipped.

**Builder integration:**
- `build({ makeLlm, embedder, buildSkillHost, connectMcp })` with a `sap-ai-sdk`
  provider, **no `AICORE_SERVICE_KEY` in env, no `.withEmbedder({model})`** →
  builds successfully (the prior dummy-env + explicit-model workarounds are
  removed from the builder tests).
- `build({ makeLlm })` (embedder NOT injected) → still validates the embedder's
  model/credentials (flag stays false).

## Out of scope (YAGNI)

- Per-role granular skipping (skip LLM-credential when only `makeLlm` injected but
  validate the embedder). The both-injected gate is sufficient for the builder's
  single-embedder surface; finer granularity is unneeded.
- Changing the server's validation behaviour in any way.
- A user-facing config key to skip validation (this is an internal embed concern,
  driven by injected deps — not a YAML knob).
