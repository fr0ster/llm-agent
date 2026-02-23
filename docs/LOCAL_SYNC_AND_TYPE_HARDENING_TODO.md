# Local Sync And Type-Hardening TODO

## Goal
- Keep `feat/smart-agent-architecture` aligned with `origin/feat/smart-agent-architecture`.
- Carry local quality improvements in a separate branch and integrate them incrementally.
- Reduce `any` usage across the codebase without breaking compatibility.

## Branch Strategy
- Source branch for local improvements: `feat/biome-warnings-cleanup-stack`.
- Main working branch for remote updates: `feat/smart-agent-architecture`.
- Integrate only focused, reviewable chunks from local branch into main branch.

## Sync Plan
1. Regularly fetch and rebase local branch on top of `origin/feat/smart-agent-architecture`.
2. Compare changes with:
   - `git diff --name-only feat/smart-agent-architecture..feat/biome-warnings-cleanup-stack`
   - `git diff feat/smart-agent-architecture..feat/biome-warnings-cleanup-stack -- <file>`
3. Cherry-pick safe commits first (formatting, non-functional hardening, helper utilities).
4. Re-run checks after each integration step:
   - `npm run lint:check`
   - `npm run build`
5. Keep risky refactors isolated in separate commits.

## Type-Hardening Plan (Reduce `any`)
1. Replace `any` with `unknown` at API boundaries.
2. Add narrow type guards and converter helpers near boundary code.
3. Replace broad `Record<string, any>` with specific interfaces where stable.
4. Keep compatibility aliases only where required by current adapters.
5. Track each `any` replacement as a scoped commit per module.

## Priority Areas
1. `src/agents/*`:
   - remove `any` in tool formatting and provider access code.
2. `src/llm-providers/*`:
   - replace `catch (error: any)` with `unknown` + safe error extraction.
3. `src/agent.ts` and `src/cli.ts`:
   - remove remaining `any` in errors and tool iteration.
4. `src/types.ts`:
   - tighten tool-related types once smart-agent adapters accept stricter contracts.

## Validation Criteria
- `npm run build` passes.
- `npm run lint:check` has no new errors and warning count trends down.
- No runtime behavior regression in existing smoke scenarios.
