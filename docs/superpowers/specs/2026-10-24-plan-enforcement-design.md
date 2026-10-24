# Plan enforcement design

Date: 2026-10-24. Implemented on top of the structured plan design of 2026-10-23.

## Design

- Scope consent is a persisted optional `Plan.scopeConsent` marker. A user turn following `waiting_user` with a question grants one successful plan update; delegation or a later unrelated user turn clears it. Asking and narrowing in the same planner turn fails. Skipping, removing unfinished steps, replacing a structured plan with text, and removing declared identifiers require consent. Identifier replacement counts as narrowing even if the total count stays unchanged. Active attempts must still settle before removal.
- Optional step `items` contains unique identifiers. Batch updates require an explicit check. Work completion enters `checking`; batch state overrides cannot manufacture a successful work attempt. Planner checks close with a verdict and note; checker checks require a passing structured verdict. The library appends the expected count and identifiers to delegated checker goals. A missing count fails with `checker did not report count for N items`; a numeric count below the expected count also overrides a pass. Changing batch membership requires a pending step and fresh work/check attempt.
- Worker budget exhaustion is an optional streaming/result flag, independent of provider stop reasons. Both worker tool loops report it at execution boundaries, including the final allowed iteration. SmartAgent and its subagent adapter propagate the flag and actual tool-call count/limit to TaskBoard. A batch with exhausted work fails without a check and receives a split hint. Exhausted work without items enters `checking`, preserves an existing check or creates a planner check, and records `Worker hit the tool-call budget N/M; verify the result is complete or split the step`. Budget-only chunks propagate metadata without emitting empty HTTP content deltas. Task event notes expose the exhausted budget, and available worker limits appear in environment notes. The optional session `maxItemsPerStep` validates updates; unset means no batch size cap.
- The bounded end-of-turn correction uses structural state only: an active plan, ready steps, no running/checking steps or active tasks, and no delegation in the turn. It asks the planner to delegate or use `waiting_user` with its question. No reply language or punctuation detection is used.
- All persisted additions are optional. Legacy plans and task records still restore. No versions change.

Plan step notes use a middle dot separator (`\u00b7` in JavaScript), with question marks reserved for unknown budget values.

## Validation

Dialogue-folder tests run with `--test-concurrency=1`. Regression coverage includes consent before/after a user response, item checks with missing/short counts, batch limits, budget propagation and failure, non-item budget checks with absent/planner/checker checks, middle dot note rendering, empty-delta suppression in HTTP streaming, and existing corrective-turn and legacy-state restoration cases. Both affected package builds and package-scoped typechecks are run sequentially.
