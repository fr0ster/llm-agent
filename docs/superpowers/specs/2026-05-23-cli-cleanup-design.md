# CLI Cleanup: YAML as Single Configuration Source

> **Status:** Design, not implemented. After approval, writing-plans skill produces the implementation plan. Closes [#134](https://github.com/fr0ster/llm-agent/issues/134).
>
> **Release target:** v15.0.0 (batched with #135, #136, #137). This work alone does NOT bump version — entries land in `CHANGELOG.md [Unreleased]`. The version bump comes in a separate release PR once all four issues are merged.

## Goal

Reduce the `llm-agent` CLI to its essential runtime-metadata role and make `smart-server.yaml` the single source of agent-behavior configuration. Remove CLI flags that configure **agent behavior** (LLM, RAG, MCP, prompts, mode, reasoning). Keep CLI flags that are **runtime / process overrides** (config path, env loading, port/host, logging, plugin discovery) — these are deployment knobs, not agent-behavior decisions, and they're useful from the command line for ad-hoc operations even though some have YAML counterparts.

When YAML is missing or invalid, the agent fails loud on startup with a clear, human-readable error — no silent defaults, no auto-detect magic.

## Why

The current CLI exposes ~16 flags that duplicate YAML-configurable behavior (`--llm-api-key`, `--llm-model`, `--rag-type`, `--mcp-url`, etc.). They were added when YAML was less complete; now they're cruft that:

- Multiplies the surface to test and document.
- Confuses precedence ("CLI > YAML > env vars > defaults" — but defaults are stale).
- Masks bad YAML by silently filling in CLI defaults the user never asked for.
- Doesn't reflect actual deployment patterns — real users (incl. this project's primary SAP/SAP-AI-Core use case) configure everything in YAML.

This change brings the CLI to runtime metadata only: where to find the YAML, which `.env` to load, what port to bind, where to log. Configuration lives in YAML. Bad YAML → startup error. No surprises.

## Non-Goals

- This is NOT adding `--llm-provider` or any auto-detect logic. The earlier framing of issue #134 proposed that; brainstorming pivoted to "YAML is the source of truth, CLI is metadata" as the cleaner model.
- No YAML field names are added or removed, but **validation semantics become stricter**. This PR changes CLI parsing AND config loading/validation semantics — specifically, the env-var fallbacks and hardcoded defaults that today silently fill in missing YAML fields for agent-identity values (credentials, model, provider, urls). Schema defaults for non-secret behavioral tuning params (temperatures, weights, timeouts) stay legal.
- This does NOT change the first-run "generate YAML template" behavior. That stays.
- This does NOT touch the bundled provider/embedder packages from v13.1.0; they remain bundled.
- This does NOT wire service-key file discovery, sessions relocation, or proxy-config reading. The `--secrets-dir` flag reserves the convention root but only the `*.env` half is consumed in this PR. Service-key file discovery is reserved for a separate follow-up issue.

---

## Changes

### Three field categories — what must come from YAML

Fields in `resolveSmartServerConfig` fall into three categories with different rules:

**Category A — Identity / credentials / endpoints. Must come from YAML (or its `${VAR}` substitution). No direct env-var fallback. No hardcoded default. Empty after substitution → startup error.**

| Field | Current direct env-var fallback (REMOVE) | Current hardcoded default (REMOVE) | Location |
|---|---|---|---|
| `llm.apiKey` | `env.DEEPSEEK_API_KEY` | — | `config.ts:449` |
| `llm.model` | `env.DEEPSEEK_MODEL` | `'deepseek-chat'` | `config.ts:497-498` |
| `rag.type` | — | `'ollama'` | `config.ts:511` |
| `rag.url` | `env.OLLAMA_URL` | `'http://localhost:11434'` | `config.ts:521-522` |
| `rag.model` | `env.OLLAMA_EMBED_MODEL` | `'nomic-embed-text'` | `config.ts:526-527` |
| `mcp.url` | `env.MCP_ENDPOINT` | — | `config.ts:459` |
| `mcp.command` | `env.MCP_COMMAND` | — | `config.ts:463` |
| `prompts.system` | `env.PROMPT_SYSTEM` | — | `config.ts:476` |
| `prompts.classifier` | `env.PROMPT_CLASSIFIER` | — | `config.ts:481` |
| `mode` | `env.SMART_AGENT_MODE` | — | `config.ts:707` |

For each: remove the `?? env.X` and any hardcoded literal. If YAML doesn't provide a value (after `${VAR}` substitution), startup fails with a human-readable error pointing at the missing field. If user wants the OLD `env.OLLAMA_URL` behavior, they write `rag.url: ${OLLAMA_URL}` in YAML — the substitution path stays.

**Category B — Non-secret behavioral tuning params. Schema defaults are LEGAL (not a "silent fallback" — they're documented defaults). No env-var fallback.**

These are scalar knobs that don't change provider/model/credential identity. A missing value is safely covered by the schema default.

| Field | Hardcoded default (KEEP as schema default) | Location |
|---|---|---|
| `llm.temperature` | `0.7` | `config.ts:502` |
| `llm.classifierTemperature` | `0.1` | `config.ts:505` |
| `rag.dedupThreshold` | `0.92` | `config.ts:532` |
| `rag.vectorWeight` | `0.7` | `config.ts:534` |
| `rag.keywordWeight` | `0.3` | `config.ts:537` |
| `agent.externalToolsValidationMode` | `'permissive'` | `config.ts:569` |
| `agent.maxIterations` | `10` | `config.ts:570` |
| `agent.maxToolCalls` | `30` | `config.ts:571` |
| `agent.toolUnavailableTtlMs` | `600000` | `config.ts:573` |
| `agent.ragQueryK` | `10` | `config.ts:575` |

Rule: schema defaults stay. No env-var fallbacks are added for these. They were never env-driven before either (verified by grep), so no removal needed.

**Category C — Runtime / process. CLI flag + YAML + env all legal sources. Defaults stay.**

| Field | Sources | Default |
|---|---|---|
| `port` | CLI `--port`, YAML `port`, `env.PORT` | `4004` |
| `host` | CLI `--host`, YAML `host` | `'0.0.0.0'` |
| log path | CLI `--log-file`/`--log-stdout`, YAML `log` | filename `smart-server.log` in cwd |
| plugin dir | CLI `--plugin-dir`, YAML `pluginDir` | — |

These are deployment knobs, not agent behavior. The full sources list stays; only the agent-behavior list above is restricted.

### What this enforces

- **Category A removals close the "silent fallback" hole** described in the Goal section. An incomplete YAML for any Category A field → clear startup error, not a quiet env-var or default value the user didn't put there.
- **Category B schema defaults remain** so users can write minimal YAML without enumerating every tuning param. These are not "silent" — they're documented in the YAML schema + template.
- **Legacy `llm.apiKey + llm.model` schema validation** (from the credential validation section above) MUST require `apiKey` to be explicitly set in YAML — typically as `apiKey: ${DEEPSEEK_API_KEY}`. The agent no longer reads `process.env.DEEPSEEK_API_KEY` directly. Shell-env alone is not a config source; YAML must reference it.

### CLI flags REMOVED

All of these duplicate YAML fields and are removed from `packages/llm-agent-server/src/smart-agent/cli.ts`:

```
--llm-api-key                       (YAML: llm.apiKey / pipeline.llm.main.apiKey)
--llm-model                         (YAML: llm.model / pipeline.llm.main.model)
--llm-temperature                   (YAML: llm.temperature / pipeline.llm.main.temperature)
--rag-type                          (YAML: rag.type / pipeline.rag.*.type)
--rag-url                           (YAML: rag.url)
--rag-model                         (YAML: rag.model)
--rag-vector-weight                 (YAML: rag.vectorWeight)
--rag-keyword-weight                (YAML: rag.keywordWeight)
--mcp-type                          (YAML: mcp.type)
--mcp-url                           (YAML: mcp.url)
--mcp-command                       (YAML: mcp.command)
--mcp-args                          (YAML: mcp.args)
--mode                              (YAML: mode)
--prompt-system                     (YAML: prompts.system)
--prompt-classifier                 (YAML: prompts.classifier)
--agent-show-reasoning              (YAML: agent.showReasoning)
```

No deprecation cycle — these are removed outright. Any startup script invoking them will fail at argument-parse time with a clear "unknown flag" error.

### CLI flags KEPT / ADDED

```
--config <path>           Path to YAML config (default: smart-server.yaml in cwd)
--secrets-dir <folder>    Override secrets root (default: ~/.config/mcp-abap-adt/).
                          Convention-shared with mcp-abap-adt-proxy etc.;
                          holds service keys, *.env, proxy/, sessions/.
--env                     Load all `*.env` files found in <secrets-dir>.
                          No argument; presence enables the directory scan.
--env-path <file>         Load the specific `.env` file at this path.
                          Overrides --env when both are passed.
--port <number>           Override YAML port — handy for ad-hoc testing
--host <string>           Override YAML host
--log-stdout              Toggle: log to stdout instead of file
--log-file <path>         Override YAML log file path
--plugin-dir <path>       Additional plugin directory (loaded after defaults)
--help                    Show usage
```

The 3 new env-related flags (`--secrets-dir`, `--env`, `--env-path`) mirror the convention already established in sibling tools (`mcp-abap-adt-proxy`, etc.) so deployment scripts share a single mental model across the family.

These are runtime-metadata-only: they tell the agent where to find configuration, secrets, and where to write output. They don't configure agent behavior beyond environment loading.

### YAML validation hardened

When the YAML loads, missing-required and bad-type errors must produce a single human-readable report (one report per startup attempt, possibly listing multiple lines of issues) — not a stack trace.

Required fields (all checked after env substitution):

1. **Either** `llm.apiKey` + `llm.model` (legacy flat schema), **or** `pipeline.llm.main.provider` + `pipeline.llm.main.model` (modern pipeline schema). At least one of these two must be complete.
2. If `provider` is set, it must be one of `openai|anthropic|deepseek|sap-ai-sdk`.
3. **Provider-specific credential validation:**
   - For `openai`, `anthropic`, `deepseek`: `apiKey` (or `pipeline.llm.main.apiKey`) is required AFTER env substitution. The expected pattern is `apiKey: ${OPENAI_API_KEY}` (or analogous) in YAML, with the env variable populated via `--env-path`, `--env`, or the OS shell. An empty/missing resolved value is a startup error: "Provider `openai` requires `pipeline.llm.main.apiKey` to resolve to a non-empty value (typically via `${OPENAI_API_KEY}` env reference)."
   - For `sap-ai-sdk`: `apiKey` is **optional** in YAML. Credentials come through `AICORE_SERVICE_KEY` env var (JSON string content of the SAP AI Core service key). The startup check validates that `AICORE_SERVICE_KEY` resolves to non-empty after env loading; if not, the human-readable error: "Provider `sap-ai-sdk` requires the `AICORE_SERVICE_KEY` env var to be set with the SAP AI Core service-key JSON content. None found."
     - **Future work, out of scope here:** service-key *file* discovery under `<secrets-dir>/service-keys/` (so users can store the JSON as a file rather than a JSON-stringified env var). The `--secrets-dir` flag reserves the convention; the file-reading wiring is a separate issue.

Error format (multi-error case batched into one report):

```
Configuration error in smart-server.yaml:
  - pipeline.llm.main.provider: required (one of: openai, anthropic, deepseek, sap-ai-sdk)
  - pipeline.llm.main.model: required (string)
  - pipeline.llm.main.apiKey: must resolve to non-empty (env var ANTHROPIC_API_KEY appears empty/unset)
Set these fields in your YAML and restart.
```

Existing Zod schema (if used) should generate the structural part of this format; a small post-Zod handler does the env-substituted credential checks and merges error lists.

### Env-loading semantics

Resolution order (highest priority wins for any specific variable):

1. **Pre-existing `process.env`** — what the OS/shell already exported. Never overwritten.
2. **`--env-path <file>`** — when given, that single file is loaded via `dotenv.config({ path: <file>, override: false })`.
3. **`--env`** — when given, every `*.env` file under `<secrets-dir>` is loaded in alphabetical order (`dotenv.config({ path: <secrets-dir>/foo.env, override: false })` for each). Later files don't override earlier (first-wins-after-shell).
4. **Implicit `.env` in cwd** — kept as a fallback ONLY when neither `--env` nor `--env-path` is given. Matches existing dotenv default behavior so projects that just `llm-agent` in their repo with a local `.env` keep working.

YAML `${VAR}` substitution reads from `process.env` after the above loading. No change to that mechanism.

#### What lives in `<secrets-dir>` beyond `*.env`

The sibling tools (`mcp-abap-adt-proxy`, etc.) place additional structured artifacts under `<secrets-dir>`:

- `service-keys/` — service account JSON files (AICORE_SERVICE_KEY content, etc.)
- `proxy/` — proxy config files
- `sessions/` — session state storage

**This PR only wires the env-loading half of the convention.** Service-keys file discovery, sessions relocation, and proxy-config integration follow in separate issues (not yet filed). Adding the `--secrets-dir` flag now reserves the convention and lets users override the root location consistently across the family of tools, even while llm-agent itself only consumes the `*.env` subset for now.

### First-run template generation

Unchanged. When `llm-agent` runs and `smart-server.yaml` doesn't exist in cwd, it writes a template and exits with a message pointing the user to fill in the template + `.env`. Already the current behavior per `docs/QUICK_START.md`.

The template content stays as-is — no field changes in this spec.

### Documentation

Update — known files:
- `docs/QUICK_START.md` — the CLI-flag table is the most stale piece. Replace with the trimmed flag list above. Add a one-paragraph note: "Agent behavior lives in `smart-server.yaml`. The CLI flags listed above are runtime/process overrides — config-file path, env loading, port/host, logging — not agent-behavior knobs."
- `CLAUDE.md` — if it lists the CLI flags anywhere, sync to the trimmed list.
- `cli.ts` JSDoc header at the top of the file — same.

Sweep — broader search to catch references outside the known files:

```bash
rg -n '\-\-(llm-api-key|llm-model|llm-temperature|rag-type|rag-url|rag-model|rag-vector-weight|rag-keyword-weight|mcp-type|mcp-url|mcp-command|mcp-args|mode|prompt-system|prompt-classifier|agent-show-reasoning)' \
  docs README.md CLAUDE.md packages \
  --glob '!*.test.ts' --glob '!dist/**' --glob '!node_modules/**'
```

Any hit found by this command must be updated (remove or rephrase). Likely candidates: plugin docs, integration docs, sample configs, examples that show old CLI invocations.

### CHANGELOG entry — added in THIS PR

This is a breaking change to a public surface. Per the project's commit-before-review and "agent pushes after CHANGELOG/docs sync" rules, an entry MUST land in `CHANGELOG.md` `[Unreleased]` as part of this PR:

```markdown
### Breaking changes
- CLI flag set trimmed to runtime/process overrides only. Removed: `--llm-api-key`, `--llm-model`, `--llm-temperature`, `--rag-type`, `--rag-url`, `--rag-model`, `--rag-vector-weight`, `--rag-keyword-weight`, `--mcp-type`, `--mcp-url`, `--mcp-command`, `--mcp-args`, `--mode`, `--prompt-system`, `--prompt-classifier`, `--agent-show-reasoning`. These previously duplicated YAML fields and are no longer accepted — passing them produces a non-zero exit with `unknown flag` error. Configure all agent behavior in `smart-server.yaml`.
- Added: `--secrets-dir <folder>` (default `~/.config/mcp-abap-adt/`), `--env` (load `*.env` from secrets-dir), `--env-path <file>` (explicit `.env` path). Mirrors the convention used in `mcp-abap-adt-proxy` and the rest of the sibling tools.
- YAML validation hardened: missing required fields / invalid provider / empty credentials produce a single human-readable error on startup instead of a stack trace.
```

The later batch-release PR will move this from `[Unreleased]` into `[15.0.0]` (alongside #135/#136/#137 entries).

### Tests

Add the cases listed below to `packages/llm-agent-server/src/__tests__/` (or wherever existing CLI tests live):

1. Removed-flag rejection: passing `--llm-api-key X` produces a non-zero exit with "unknown flag" or equivalent. No silent ignore.
2. Bad YAML — missing required field: produces a human-readable error with the field path, NOT a stack trace.
3. Bad YAML — invalid provider value: produces a human-readable error listing valid options.
4. Provider credential validation — openai/anthropic/deepseek: `provider: openai` with no resolvable `apiKey` produces a clear error pointing at the env-var name to set.
5. Provider credential validation — sap-ai-sdk: missing/empty `AICORE_SERVICE_KEY` produces the SAP-specific error message naming the env var (no mention of file mechanism, since not wired in this PR).
6. Kept flags still work: `--port`, `--config`, `--log-stdout` etc. continue to function as before.
7. `--env-path <file>` loads variables from the specified file.
8. `--env` scans `<secrets-dir>` for `*.env` and loads them in alphabetical order.
9. `--secrets-dir <folder>` redirects the `--env` scan to the given folder.
10. Pre-existing `process.env` values take precedence over any file-loaded value (no override).
11. Implicit `.env` fallback works when neither `--env` nor `--env-path` is given.

### CLI parser strictness

`node:util.parseArgs` is currently called with `strict: false` in `cli.ts`, which silently ignores unknown flags. The Removed-flag rejection test above requires the OPPOSITE behavior. Pick ONE of:

(a) **Switch to `strict: true`**. Node's parseArgs in strict mode throws on unknown flags and produces a clean error message via its own machinery. Cleanest; preferred.

(b) **Manual unknown-flag detection**. After parseArgs, inspect any leftover `positionals` or compare known-flag set against received arg names and bail with custom error. More code; only justified if strict mode breaks something else (e.g. tooling that injects extra args via env).

Implementation plan should pick (a) unless a concrete blocker surfaces; (b) is a fallback.

---

## Semver

CLI surface change is breaking. Batched into v15.0.0 alongside #135/#136/#137. This PR:
- Does NOT bump versions (no `13.x → 15.0.0` in package.json files).
- DOES add an entry to `CHANGELOG.md [Unreleased]` under `### Breaking changes` (see "CHANGELOG entry" section above). The breaking surface change must be captured at the time it lands; the later release PR consolidates `[Unreleased]` into the dated `[15.0.0]` section.

---

## What This Changes In Current Code

| Component | Path | Change |
|---|---|---|
| CLI argument parser | `packages/llm-agent-server/src/smart-agent/cli.ts` | Remove ~16 flag handlers; keep the 11 listed above (8 existing + 3 new env-related). Switch parseArgs to `strict: true`. |
| CLI usage/help string | same file (top JSDoc + `--help` output) | Trim to match new flag set. |
| Env-var and default fallbacks | `packages/llm-agent-server/src/smart-agent/config.ts` (`resolveSmartServerConfig`) | Remove direct env reads + hardcoded defaults for agent-behavior fields (see table above). Runtime/process defaults stay. |
| Provider credential validation | `packages/llm-agent-server/src/smart-agent/config.ts` (post-load checks) | Add provider-specific required-field checks (apiKey resolution for openai/anthropic/deepseek; AICORE_SERVICE_KEY non-empty for sap-ai-sdk). |
| YAML validation error formatter | same file (`loadYamlConfig` + neighbors) | Convert raw validation errors into the human-readable batched-report format. |
| Tests | `packages/llm-agent-server/src/__tests__/cli-*.test.ts` (existing or new) | Add the 11 cases listed in the Tests section above. |
| `docs/QUICK_START.md` | docs | Replace CLI-flag table with trimmed list + paragraph. |
| `CLAUDE.md` | top-level | Sync any CLI-flag references. |
| `CHANGELOG.md` | `[Unreleased]` | Add an entry under a new "### Breaking changes" subsection. |

---

## Implementation Boundaries

Single coherent change, one PR, one feature branch (`chore/cli-cleanup`). No need to phase. The PR merges into main on current 14.0.0 versions; version bump comes later.

---

## Self-Review

1. **Placeholder scan:** no TBDs. All flag names listed explicitly. Error format example concrete.
2. **Internal consistency:** "Removed flags" and "Kept flags" together cover the current CLI flag set per the help text. No overlap, no orphan.
3. **Scope check:** Single-concern PR — CLI cleanup. Doc updates are direct consequences (the docs reference the removed flags). Test additions are direct consequences. No drift.
4. **Ambiguity check:** Validation error format is shown with a concrete example, so error-message implementation can match. Required-fields rule explicitly covers both legacy flat and modern pipeline schemas, which co-exist in the current YAML loader.

No issues found. Spec ready for plan.
