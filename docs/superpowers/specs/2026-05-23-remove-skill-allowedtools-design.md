# Remove `allowedTools` From `ISkillMeta` (v13.2.0)

> **Status:** Design, not implemented. After this spec is approved, the writing-plans skill produces the implementation plan.

## Goal

Remove the misleading `allowedTools?: string[]` field from `ISkillMeta` (and the corresponding `allowed-tools` frontmatter mapping in `ClaudeSkillManager`). The field was never enforced at runtime, is not part of any actual Claude/OpenAI skill format, and conflates skill guidance (prose) with tool authorization (an unrelated concern that belongs to the MCP transport layer).

## Why Now

GitHub issue [#133](https://github.com/fr0ster/llm-agent/issues/133) framed this as an enforcement bug — "field exists, parsed, but never applied". On re-examination during brainstorming, the field itself is the bug:

- **Tools live in MCP-RAG, not in skills.** Our architecture has a single MCP-RAG catalog shared across all subagents. Skills are markdown prose with `name` + `description` frontmatter.
- **Skills give guidance, not authorization.** A skill can recommend "for full program code use `GetProgramFullCode`" in its body. The LLM reads the recommendation and chooses from the full MCP catalog. No structured field needed.
- **`allowed-tools` is a Claude Code subagent convention** (`.claude/agents/*.md`), not a skill convention (`.claude/skills/*/SKILL.md`). `ClaudeSkillManager` incorrectly borrowed it.
- **No real skill in this project uses the field.** The `sap-abap-development/SKILL.md` example has only `name` + `description`.

So the right fix is not "enforce the field" — it's "remove the field".

True tool authorization (e.g. read-only mode, sandbox, per-tenant restrictions) is a separate concern best addressed at the MCP server layer (which tools the server exposes per request, based on headers / auth context) or as middleware. That work is out of scope for this spec and tracked separately if/when needed.

## Non-Goals

- Adding any new authorization mechanism in place of `allowedTools`.
- Introducing a RAG-bias hint (e.g. "boost rank of these tools when this skill is active"). Premature optimization — the LLM reads skill prose and picks from full MCP-RAG; biasing layer adds complexity without proven need.
- Touching Claude Code subagent definitions or the `.claude/agents/` format (out of project scope).

---

## Concept

`ISkillMeta` is a public TypeScript contract. Removing one field is a **breaking type change** even though the runtime impact is zero (the field was never read by any handler). Downstream consumers who declared `allowedTools: [...]` on their custom `ISkill` implementations will see a TypeScript compile error after upgrading.

The change is intentionally pure cleanup: no behavior change, no new behavior added.

---

## Changes

### Removed

**`packages/llm-agent/src/interfaces/skill.ts`:**
- Delete the field `allowedTools?: string[]` from `ISkillMeta`.

**`packages/llm-agent-libs/src/skills/claude-skill-manager.ts`:**
- Delete the lines mapping `allowed-tools` → `allowedTools` (currently lines ~92-94 in the parse loop).
- Delete the JSDoc bullet `- 'allowed-tools' → 'allowedTools'` from the file header comment (currently line ~10).
- Forward-compat: if a Claude Code subagent file is mistakenly placed under `.claude/skills/` and its frontmatter contains `allowed-tools`, the key is now silently dropped during parse (no error, no warning). This is acceptable — such files are misplaced; they belong under `.claude/agents/`, which our `ClaudeSkillManager` does not scan.

### Modified

**`CHANGELOG.md`:**
- New section `## [13.2.0] — 2026-05-23` with `### Removed` block describing the field removal.
- Highlight that runtime behavior is unchanged (the field was never enforced) but downstream TypeScript consumers must update their `ISkill` implementations if they declared the field.

**All 15 packages: bump version `13.1.0` → `13.2.0`.** Internal `@mcp-abap-adt/*` dep ranges bumped to `^13.2.0`.

### Documentation

**`docs/INTEGRATION.md` (skills section, if it has any concrete reference to `allowedTools`):**
- Remove any mention of `allowedTools`.
- Add a short paragraph: skill authors recommend tools by **mentioning them in the skill body** (markdown prose). The LLM reads the prose, sees the recommendation, and picks the tool from the MCP-RAG catalog. No structured field is needed or supported.

Grep `docs/` for any other mentions of `allowedTools` and either remove (if they advertised enforcement) or rephrase (if they discussed the concept generally).

---

## Semver

`v13.2.0` (minor) — the field was never enforced at runtime, the project itself never used it in any real skill, and removing it has zero runtime impact. Strict semver would say major (public-type field removal), but the practical impact on downstream consumers is essentially nil: any user who declared `allowedTools` on a custom `ISkill` was relying on documentation that misled them; nothing else breaks.

Minor bump signals "non-breaking enhancement" with the caveat that TypeScript-strict consumers may see a compile error and need a 1-line fix. CHANGELOG documents this clearly.

---

## What This Changes In Current Code

| Component | Path | Change |
|---|---|---|
| `ISkillMeta.allowedTools` | `packages/llm-agent/src/interfaces/skill.ts` | Removed. |
| `allowed-tools` parser branch | `packages/llm-agent-libs/src/skills/claude-skill-manager.ts:~92-94` | Removed. |
| Header JSDoc bullet | `packages/llm-agent-libs/src/skills/claude-skill-manager.ts:~10` | Removed. |
| Version bumps | All 15 `packages/*/package.json` | `13.1.0` → `13.2.0`; internal deps `^13.2.0`. |
| Lockfile | `package-lock.json` | Synced. |
| CHANGELOG | `CHANGELOG.md` | New `[13.2.0]` section. |
| Docs | `docs/INTEGRATION.md` and any other `docs/*.md` with `allowedTools` mentions | Removed or rephrased. |

---

## Implementation Boundaries

This is a single coherent change — no need to phase it. One implementation plan, one release commit, one tag `v13.2.0`.

The follow-on work (MCP-layer tool authorization, if ever needed) is a different feature for a different release; out of scope.

---

## Self-Review

1. **Placeholder scan:** no TBDs.
2. **Internal consistency:** "what this changes" table matches the "changes" prose. Non-goals align with what's being removed.
3. **Scope check:** Single focused change (one type field removal + its parser branch + docs + version bump). Implementable in one PR.
4. **Ambiguity check:** Forward-compat handling for misplaced subagent files in skills directories is explicitly documented (silent drop). No ambiguity about what happens to old skill files with `allowed-tools`.

No issues found. Spec ready for plan.
