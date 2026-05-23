# CLI Cleanup: YAML as Single Configuration Source

> **Status:** Design, not implemented. After approval, writing-plans skill produces the implementation plan. Closes [#134](https://github.com/fr0ster/llm-agent/issues/134).
>
> **Release target:** v15.0.0 (batched with #135, #136, #137). This work alone does NOT bump version — entries land in `CHANGELOG.md [Unreleased]`. The version bump comes in a separate release PR once all four issues are merged.

## Goal

Reduce the `llm-agent` CLI to its essential runtime-metadata role and make `smart-server.yaml` the single source of configuration. Remove all CLI flags that duplicate YAML fields. When YAML is missing or invalid, the agent fails loud on startup with a clear, human-readable error — no silent defaults, no auto-detect magic.

## Why

The current CLI exposes ~16 flags that duplicate YAML-configurable behavior (`--llm-api-key`, `--llm-model`, `--rag-type`, `--mcp-url`, etc.). They were added when YAML was less complete; now they're cruft that:

- Multiplies the surface to test and document.
- Confuses precedence ("CLI > YAML > env vars > defaults" — but defaults are stale).
- Masks bad YAML by silently filling in CLI defaults the user never asked for.
- Doesn't reflect actual deployment patterns — real users (incl. this project's primary SAP/SAP-AI-Core use case) configure everything in YAML.

This change brings the CLI to runtime metadata only: where to find the YAML, which `.env` to load, what port to bind, where to log. Configuration lives in YAML. Bad YAML → startup error. No surprises.

## Non-Goals

- This is NOT adding `--llm-provider` or any auto-detect logic. The earlier framing of issue #134 proposed that; brainstorming pivoted to "YAML is the source of truth, CLI is metadata" as the cleaner model.
- This does NOT change YAML schema (no new fields, no removed fields). It only changes the CLI parser.
- This does NOT change the first-run "generate YAML template" behavior. That stays.
- This does NOT touch the bundled provider/embedder packages from v13.1.0; they remain bundled.

---

## Changes

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

### CLI flags KEPT

```
--config <path>           Path to YAML config (default: smart-server.yaml in cwd)
--env <path>              Path to .env file (default: .env in cwd)
--port <number>           Override YAML port — handy for ad-hoc testing
--host <string>           Override YAML host
--log-stdout              Toggle: log to stdout instead of file
--log-file <path>         Override YAML log file path
--plugin-dir <path>       Additional plugin directory (loaded after defaults)
--help                    Show usage
```

These are runtime-metadata-only: they tell the agent where to find configuration, where to write output, what port to bind. They don't configure agent behavior.

### YAML validation hardened

When the YAML loads, missing-required and bad-type errors must produce a single-line human-readable message — not a stack trace.

Required fields:
- Either `llm.apiKey` + `llm.model` (legacy flat schema), OR `pipeline.llm.main.provider` + `pipeline.llm.main.model` (modern pipeline schema). At least one of these two must be complete.
- If `provider` is set, it must be one of `openai|anthropic|deepseek|sap-ai-sdk`.

Error format:

```
Configuration error in smart-server.yaml:
  - pipeline.llm.main.provider: required (one of: openai, anthropic, deepseek, sap-ai-sdk)
  - pipeline.llm.main.model: required (string)
Set these fields in your YAML and restart.
```

Existing Zod schema (if used) should generate this format; otherwise a small handler maps validation errors to this style.

### First-run template generation

Unchanged. When `llm-agent` runs and `smart-server.yaml` doesn't exist in cwd, it writes a template and exits with a message pointing the user to fill in the template + `.env`. Already the current behavior per `docs/QUICK_START.md`.

The template content stays as-is — no field changes in this spec.

### Documentation

Update:
- `docs/QUICK_START.md` — the CLI-flag table is the most stale piece. Replace with the trimmed flag list above. Add a one-paragraph note: "All agent configuration lives in `smart-server.yaml`. The CLI flags above are runtime overrides for testing convenience only."
- `CLAUDE.md` — if it lists the CLI flags anywhere, sync to the trimmed list.
- `cli.ts` JSDoc header at the top of the file — same.

No CHANGELOG entry in this PR (entries accumulate in `[Unreleased]` and consolidate into `[15.0.0]` later, per the batch-release decision). When the batch release happens, the `[15.0.0]` section should call out CLI flag removal under `### Breaking changes` with the full removed-flags list for migration reference.

### Tests

Add to `packages/llm-agent-server/src/__tests__/` (or wherever existing CLI tests live):

1. Removed-flag rejection: passing `--llm-api-key X` produces a non-zero exit with "unknown flag" or equivalent. No silent ignore.
2. Bad YAML — missing required field: produces a human-readable error with the field path, NOT a stack trace.
3. Bad YAML — invalid provider value: produces a human-readable error listing valid options.
4. Kept flags still work: `--port`, `--config`, `--env`, `--log-stdout` etc. continue to function as before.

---

## Semver

CLI surface change is breaking. Batched into v15.0.0 alongside #135/#136/#137. This PR alone:
- Does NOT bump versions.
- Adds entries to `CHANGELOG.md [Unreleased]`.
- The version bump + `[15.0.0]` section creation happens in a later release PR once the batch is complete.

---

## What This Changes In Current Code

| Component | Path | Change |
|---|---|---|
| CLI argument parser | `packages/llm-agent-server/src/smart-agent/cli.ts` | Remove ~16 flag handlers; keep the 8 listed above. |
| CLI usage/help string | same file (top JSDoc + `--help` output) | Trim to match. |
| YAML validation error formatter | `packages/llm-agent-server/src/smart-agent/config.ts` (`loadYamlConfig` + neighbors) | Convert raw validation errors into the human-readable format above. |
| Tests | `packages/llm-agent-server/src/__tests__/cli-*.test.ts` (existing or new) | Add the 4 cases listed above. |
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
