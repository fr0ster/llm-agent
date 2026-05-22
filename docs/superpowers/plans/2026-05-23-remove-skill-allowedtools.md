# Remove `ISkillMeta.allowedTools` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unused `allowedTools?: string[]` field from `ISkillMeta`, drop its parser branch in `ClaudeSkillManager`, update stale docs, bump all 15 packages to v13.2.0, sync lockfile, and tag.

**Architecture:** Pure cleanup — no behavior change. Field was never enforced at runtime, was incorrectly borrowed from Claude Code's subagent format (not the skill format), and the project's real skills never used it. Removing 1 interface field + 1 parser branch + doc references; the rest is the standard release ritual (version bump, CHANGELOG, lockfile, tag).

**Tech Stack:** TypeScript (strict, ESM), Biome lint/format, `node:test`. No new dependencies. Spec at `docs/superpowers/specs/2026-05-23-remove-skill-allowedtools-design.md`.

---

## File Structure

**Modified:**
- `packages/llm-agent/src/interfaces/skill.ts` — remove `allowedTools?: string[]` field from `ISkillMeta` (line 23).
- `packages/llm-agent-libs/src/skills/claude-skill-manager.ts` — remove parser branch (lines 92-94) + JSDoc bullet in file header (line 10).
- `docs/EXAMPLES.md` — remove `allowed-tools` from SKILL.md example (lines ~288-289) and from the frontmatter-fields table (line 311).
- `docs/ARCHITECTURE.md` — remove `allowed-tools` from SKILL.md format snippet (lines ~424-425).
- `CHANGELOG.md` — `[Unreleased]` → `[13.2.0] — 2026-05-23` with `### Removed` block.
- All 15 `packages/*/package.json` — bump `13.1.0` → `13.2.0`; internal deps `^13.1.0` → `^13.2.0`.
- `package-lock.json` — synced.

**Created:** none.
**Deleted:** none.

---

## Task 1: Remove `allowedTools` from `ISkillMeta`

**Files:**
- Modify: `packages/llm-agent/src/interfaces/skill.ts:23`

- [ ] **Step 1: Delete the field**

In `packages/llm-agent/src/interfaces/skill.ts`, line 23, delete this line:

```typescript
  allowedTools?: string[];
```

After the edit, `ISkillMeta` looks like:

```typescript
export interface ISkillMeta {
  name: string;
  description: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  model?: string;
  context?: 'inline' | 'fork';
  argumentHint?: string;
  steps?: Array<{
    id: string;
    goal: string;
    // ... (rest of the existing nested shape unchanged)
  }>;
}
```

(The exact rest of the interface — particularly the `steps?` sub-shape — must be preserved as-is. Only line 23 is removed.)

- [ ] **Step 2: Build to surface any TypeScript errors**

Run from repo root:

```bash
npm --prefix packages/llm-agent run build
```

Expected: clean.

If something fails (some downstream `ISkill` implementation declared `allowedTools`), fix that file by deleting its `allowedTools` declaration. Use grep to locate:

```bash
grep -rn "allowedTools" packages --include='*.ts'
```

Each match outside `claude-skill-manager.ts` (which is fixed in Task 2) is a downstream consumer to clean.

- [ ] **Step 3: Do NOT commit yet** — Task 2 follows and lands together.

---

## Task 2: Remove `allowed-tools` parser branch in `ClaudeSkillManager`

**Files:**
- Modify: `packages/llm-agent-libs/src/skills/claude-skill-manager.ts:10, 92-94`

- [ ] **Step 1: Delete the JSDoc bullet (line 10)**

In `packages/llm-agent-libs/src/skills/claude-skill-manager.ts`, near the top of the file, the header JSDoc lists handled frontmatter mappings. Find and delete this bullet:

```typescript
 * - `allowed-tools` → `allowedTools`
```

Leave adjacent bullets (`disable-model-invocation`, `user-invocable`, `argument-hint`) untouched.

- [ ] **Step 2: Delete the parser branch (lines 92-94)**

In the same file, locate this block:

```typescript
  if ('allowed-tools' in result) {
    result.allowedTools = result['allowed-tools'] as string[];
    delete (result as Record<string, unknown>)['allowed-tools'];
  }
```

Delete the entire `if` block. The surrounding code (other frontmatter key mappings) stays.

- [ ] **Step 3: Build + test**

```bash
npm run build
npm --prefix packages/llm-agent-libs test
```

Expected: build clean, all tests pass. If a test referenced `allowedTools`, remove the reference. Use:

```bash
grep -rn "allowedTools\|allowed-tools" packages --include='*.ts'
```

Expected: no hits.

- [ ] **Step 4: Lint**

```bash
npm run lint:check
```

Expected: clean.

- [ ] **Step 5: Commit (combined Task 1 + Task 2 changes)**

```bash
git add packages/llm-agent/src/interfaces/skill.ts packages/llm-agent-libs/src/skills/claude-skill-manager.ts
git commit -m "refactor(llm-agent): remove unused ISkillMeta.allowedTools and its Claude Code parser branch"
```

---

## Task 3: Remove `allowed-tools` from documentation

**Files:**
- Modify: `docs/EXAMPLES.md:~288-289, 311`
- Modify: `docs/ARCHITECTURE.md:~424-425`

- [ ] **Step 1: `docs/EXAMPLES.md` SKILL.md example block**

Locate the example around line 282-298 (the SKILL.md frontmatter sample). Currently:

```markdown
---
name: code-review
description: Guidelines for reviewing pull requests
user-invocable: true
argument-hint: "<PR number or diff>"
allowed-tools:
  - gh_pr_view
  - gh_pr_diff
---
```

Remove the `allowed-tools` block (3 lines). After edit:

```markdown
---
name: code-review
description: Guidelines for reviewing pull requests
user-invocable: true
argument-hint: "<PR number or diff>"
---
```

- [ ] **Step 2: `docs/EXAMPLES.md` frontmatter-fields table**

Around line 311 there's a row in the field-reference table:

```markdown
| `allowed-tools` | `string[]` | MCP tools this skill is allowed to use |
```

Delete this row entirely.

- [ ] **Step 3: `docs/ARCHITECTURE.md` SKILL.md format snippet**

Around line 425 there's a similar SKILL.md sample. Currently:

```markdown
---
name: skill-name
description: One-line description (used for RAG matching)
user-invocable: true
argument-hint: "<argument description>"
allowed-tools:
  - tool_name
---
```

Remove the `allowed-tools` block (2 lines). After edit:

```markdown
---
name: skill-name
description: One-line description (used for RAG matching)
user-invocable: true
argument-hint: "<argument description>"
---
```

- [ ] **Step 4: Sweep for any other doc references**

```bash
grep -rn "allowed-tools\|allowedTools" docs/ --include='*.md'
```

Expected: no hits after Steps 1-3.

- [ ] **Step 5: Commit**

```bash
git add docs/EXAMPLES.md docs/ARCHITECTURE.md
git commit -m "docs: remove allowed-tools from skill examples and field reference"
```

---

## Task 4: Version bump to 13.2.0 + CHANGELOG + lockfile sync + tag

**Files:**
- Modify: all 15 `packages/*/package.json` — version + internal `@mcp-abap-adt/*` ranges
- Modify: `CHANGELOG.md`
- Modify: `package-lock.json` (regenerated)

- [ ] **Step 1: Bump all 15 packages**

In each `packages/*/package.json` file:

a) Change `"version": "13.1.0"` → `"version": "13.2.0"`.
b) In `dependencies`, `peerDependencies`, etc., change any range `^13.1.0` (for `@mcp-abap-adt/*` packages) → `^13.2.0`.

External-package versions (e.g. `zod`, `dotenv`, `@modelcontextprotocol/sdk`) untouched.

Use jq or scripted sed if convenient, but verify each file by hand. Root `package.json` left at `0.0.0` per project convention (private monorepo wrapper).

- [ ] **Step 2: Verify all bumps**

```bash
grep -E '"version":\s*"13\.[01]\.[01]"' packages/*/package.json
```

Expected: only `"version": "13.2.0"` lines (no `13.0.x` or `13.1.x` left).

```bash
grep -E '"\^13\.1\.0"' packages/*/package.json
```

Expected: no hits (all internal dep ranges bumped).

- [ ] **Step 3: Update CHANGELOG.md**

In `CHANGELOG.md`, find the `## [Unreleased]` section (currently empty after the v13.1.0 release). Rename to `## [13.2.0] — 2026-05-23` and add an empty new `## [Unreleased]` block ABOVE it.

Under `[13.2.0]`:

```markdown
## [13.2.0] — 2026-05-23

### Removed
- `ISkillMeta.allowedTools` and the `allowed-tools` frontmatter mapping in `ClaudeSkillManager`. The field was never enforced at runtime, was incorrectly borrowed from Claude Code's subagent format (subagents are a different abstraction from skills), and the project's real skills never used it. Skill authors who want to recommend specific MCP tools should mention them in the SKILL.md body — the LLM reads the prose, sees the recommendation, and selects from the full MCP catalog.

### Note for downstream TypeScript consumers
- If you have a custom `ISkill` implementation that declares `allowedTools`, delete that declaration. Runtime behavior is unchanged (the field was never read by any handler).

### Documentation
- Removed `allowed-tools` from skill examples in `docs/EXAMPLES.md` and `docs/ARCHITECTURE.md`; removed the field reference row from the EXAMPLES.md frontmatter-fields table.
```

- [ ] **Step 4: Sync package-lock.json**

```bash
npm install --package-lock-only
```

Expected: lockfile updates (mainly version field changes).

- [ ] **Step 5: Full build + lint + test**

```bash
npm run clean
npm run build
npm run lint:check
npm --prefix packages/llm-agent-libs test
npm --prefix packages/llm-agent-server test
```

Expected: all clean. libs ≥ 359 pass, server 40 pass (no test count change — this is a pure removal).

- [ ] **Step 6: Commit + tag**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(release): bump to 13.2.0 — remove unused ISkillMeta.allowedTools

All 15 packages bumped uniformly. Internal @mcp-abap-adt/* dep ranges bumped to ^13.2.0. CHANGELOG.md gains a [13.2.0] section.

The `allowedTools` field on `ISkillMeta` and its Claude Code `allowed-tools` frontmatter parser branch are removed. The field was never enforced at runtime, was incorrectly borrowed from Claude Code's SUBAGENT format (not the skill format), and no real skill in this project used it. Closes GitHub issue #133.

Skill authors who want to recommend specific MCP tools should mention them in the SKILL.md body — the LLM reads the prose, sees the recommendation, and selects from the full MCP catalog.

Spec: docs/superpowers/specs/2026-05-23-remove-skill-allowedtools-design.md
EOF
)"

git tag -a v13.2.0 -m "Release 13.2.0 — remove unused ISkillMeta.allowedTools"
```

DO NOT push tag. DO NOT publish to npm. User drives both manually.

---

## Task 5: Push (after user reviews CHANGELOG/docs synchronization)

**Per user convention** (`feedback_release_flow.md`): agent pushes only after docs + CHANGELOG are synchronized for the release. npm publish is user-only (yubikey).

- [ ] **Step 1: Verify docs are coherent with the release**

```bash
grep -rn "allowedTools\|allowed-tools" docs packages 2>/dev/null | grep -v node_modules
```

Expected: no hits anywhere in `docs/` or `packages/` (other than this plan + the spec, both of which are about the removal — those are expected and will be cleaned up in Step 3).

- [ ] **Step 2: Push commit + tag**

```bash
git push origin main
git push origin v13.2.0
```

- [ ] **Step 3: Delete this plan file per repo policy**

```bash
git rm docs/superpowers/plans/2026-05-23-remove-skill-allowedtools.md
git commit -m "chore(docs): remove implemented remove-skill-allowedtools plan"
git push origin main
```

- [ ] **Step 4: Close GitHub issue #133**

```bash
gh issue close 133 --comment "Fixed in v13.2.0 by removing the misleading \`allowedTools\` field. See CHANGELOG.md and commit ${COMMIT_SHA}."
```

Replace `${COMMIT_SHA}` with the actual release commit SHA from Task 4 Step 6.

---

## Self-Review

**Spec coverage:**
- ✅ Field removal from `ISkillMeta` — Task 1.
- ✅ Parser branch removal in `ClaudeSkillManager` — Task 2.
- ✅ JSDoc bullet removal — Task 2 Step 1.
- ✅ Forward-compat (silently drop misplaced subagent files) — implicit: removing the parser branch means an unknown `allowed-tools` key in some YAML frontmatter is simply not mapped to `allowedTools`. yaml parser keeps the key as a generic record entry; `ISkillMeta` ignores unknown fields. No error, no warning. Matches spec's "silently dropped" semantics.
- ✅ CHANGELOG entry under `[13.2.0]` — Task 4 Step 3.
- ✅ Version bump all 15 packages → 13.2.0 — Task 4 Steps 1-2.
- ✅ Docs sweep (EXAMPLES.md + ARCHITECTURE.md) — Task 3.
- ✅ Tag `v13.2.0` (not pushed yet) — Task 4 Step 6.
- ✅ Push gated on docs sync per `feedback_release_flow.md` — Task 5.
- ✅ Plan-file cleanup per repo policy — Task 5 Step 3.
- ✅ Close issue #133 — Task 5 Step 4.

**Placeholder scan:** no TBDs. Every step has the actual code/command needed.

**Type consistency:** only one type is touched (`ISkillMeta`). Field name `allowedTools` used consistently across all tasks. CHANGELOG wording matches spec.

**Out of scope (per spec Non-Goals):** no new authorization mechanism, no RAG-bias hint, no `.claude/agents/` touches. Plan stays inside the cleanup scope.

No issues found. Plan ready for execution.
