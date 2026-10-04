# Decision models (`IDecisionModel`) + TypeSafe Jev provider + `DecisionReranker`

Status: design approved in brainstorming 2026-10-02; implemented on
`feat/decision-model` (Tasks 1–14). **Addendum A (§13, 2026-10-04)** adds per-store
retrieval strategies and supersedes the `reranker:` YAML section of §7.1/§7.3 —
addendum approved. **Addendum B (§14, 2026-10-04)** wires the server's
configuration into the per-session agents that serve requests and adds request
cancellation — awaiting review.
Follow-up (separate spec, after this ships): a decision-model gate in front of
`LlmEvaluator` (cascade).

## 1. Problem

TypeSafe AI's **Jev** (released 2026-09-15, GA 2026-09-20) is a "System One"
decision model: it takes a *state* (text or JSON) plus named *questions* and
returns **numbers only** — a yes/no probability (`noul`), a categorical choice
with a probability distribution (`choice`), or a position on an ordered rubric
(`score`). It generates no text, makes no tool calls, does not stream, and
produces no embeddings.

None of our model contracts fit:

- `ILlm` (`packages/llm-agent/src/interfaces/llm.ts`) requires `chat` /
  `streamChat` returning text and tool calls — a Jev-backed `ILlm` would be a lie
  that breaks every role expecting text.
- `IEmbedder` requires vectors.
- The existing *role* interfaces (`IEvaluator`, `IReviewer`, `IReranker`,
  `IOutputValidator`, `ISubpromptClassifier`) describe *what* is decided, not
  *with what*; most of them also require text output (`missing`, `feedback`,
  `approved`/`digest`, subprompt `text`).

So a decision model is a **new model capability**, a peer of `ILlm` and
`IEmbedder`, with role implementations built on top of it.

## 2. Goals / non-goals

Goals:

1. A vendor-neutral contract `IDecisionModel` in `@mcp-abap-adt/llm-agent`.
2. A provider package `@mcp-abap-adt/typesafe-decision` implementing it for Jev.
3. A first real consumer: `DecisionReranker` (`IReranker`) in
   `@mcp-abap-adt/llm-agent-libs`, plus usage accounting for decision calls.
4. YAML wiring in SmartServer (`decision:` + `reranker:` sections) and the
   binary's composition root, so the app demonstrates the capability.
   *Superseded by §13:* the `reranker:` section is replaced by per-store
   `rag.retrieval` strategies.
5. Additive only — minor release **30.1.0**.

Non-goals:

- The evaluator cascade (next spec).
- ~~`reranker.type: llm`~~ — now in scope, see §13.5.
- Health check / model listing on decision models (a separate small interface
  later, if needed).
- ~~Rerank in the controller pipeline~~ — now in scope: a store-level strategy
  reaches every pipeline, including the controller's per-step tool selection
  (§13.3).

## 3. Source of truth for the Jev API

Verified against the published SDK **`@typesafe-ai/sdk@0.6.0`** (MIT, zero
dependencies, Node ≥ 20), `dist/index.d.mts` and `dist/index.mjs` — not against
blog posts (one of which misspells the question types as `Choice`/`Score`).

- `POST {baseURL}/v1/systemone`, body `{ state, questions, model }`;
  `Authorization: Bearer <key>`; default base URL `https://api.typesafe.ai`,
  default model `jev-latest`.
- Question types (lowercase literals): `noul` (`instructions?`, `criteria?:
  {true?, false?}`), `choice` (`instructions?`, `criteria: {label: description|null}`),
  `score` (`instructions?`, `criteria: [≥2 descriptions]`, index = score).
- Answers: `noul → { type, noul }` (P(yes), **no confidence**);
  `choice → { type, choice, confidence, probabilities }`;
  `score → { type, score, confidence, legend, probabilities }`.
- Result: `{ model, answers, usage: { input_tokens, output_tokens } }`.
- Errors: `APIError` subclasses by status (400 `BadRequestError`, 401
  `AuthenticationError`, 403 `PermissionDeniedError`, 404 `NotFoundError`, 422
  `UnprocessableEntityError`, 429 `RateLimitError`, 5xx `InternalServerError`),
  `APIConnectionError` / `APITimeoutError`, `APIUserAbortError`, and the base
  `TypeSafeError` thrown before any request (e.g. empty `questions`, score
  criteria shorter than 2).
- Built-in retry: default 2 retries on 408/429/5xx and connection/timeout
  errors, exponential backoff, honours `Retry-After`/`retry-after-ms`;
  per-attempt timeout default 10 000 ms; `AbortSignal` supported.
- Published limits (secondary source, not in the SDK): 64k tokens per request
  (state + all questions), 32k for state + longest question; 1 200 req/min.

Two SDK behaviours the design must neutralise:

1. **The API key is fixed at construction.** `fetchWithRetries` builds headers
   with `mergeHeaders(req.headers, { Authorization: \`Bearer ${#apiKey}\` … })`
   and later sources win, so a per-call `Authorization` header is overwritten.
2. **Environment fallbacks.** The constructor reads `TYPESAFE_API_KEY`,
   `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, `TYPESAFE_LOG_LEVEL` when the
   option is omitted; at `debug` the SDK logs request bodies unredacted.

## 4. Contract — `@mcp-abap-adt/llm-agent`

New file `packages/llm-agent/src/interfaces/decision-model.ts`, exported from the
package index.

```ts
import type { JsonValue } from './tool-loop-context-strategy.js';
import { type CallOptions, type Result, SmartAgentError } from './types.js';

/** What is judged, and how a question or criterion is put: text, a JSON object, or a JSON array. */
export type DecisionEntry = string | { [k: string]: JsonValue } | JsonValue[];

export interface NoulQuestion {
  type: 'noul';
  instructions?: DecisionEntry;
  criteria?: { true?: DecisionEntry; false?: DecisionEntry };
}
export interface ChoiceQuestion {
  type: 'choice';
  instructions?: DecisionEntry;
  /** At least two labels; a `null` description leaves the label undescribed. */
  criteria: Record<string, DecisionEntry | null>;
}
export interface ScoreQuestion {
  type: 'score';
  instructions?: DecisionEntry;
  /** At least two rubric levels; the index is the score. */
  criteria: readonly (DecisionEntry | null)[];
}
export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer { type: 'noul'; /** P(yes), 0..1 */ probability: number }
export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface ScoreAnswer {
  type: 'score';
  /** Expected score; may fall between integer rubric levels. */
  score: number;
  confidence: number;
  probabilities: Record<number, number>;
}
export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionRequest {
  state: DecisionEntry;
  /** Non-empty; keys name the answers. */
  questions: Record<string, DecisionQuestion>;
}
export interface DecisionResult {
  /** Same keys as `questions`; each answer's `type` matches its question's. */
  answers: Record<string, DecisionAnswer>;
  /** The model that actually answered (e.g. `jev-1.13.0` for `jev-latest`). */
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export type DecisionErrorCode =
  | 'DECISION_UNSUPPORTED_QUESTION'
  | 'DECISION_INVALID_REQUEST'
  | 'DECISION_AUTH'
  | 'DECISION_RATE_LIMITED'
  | 'DECISION_UNAVAILABLE'
  | 'DECISION_ABORTED'
  | 'DECISION_ERROR';

export class DecisionError extends SmartAgentError {
  constructor(message: string, code: DecisionErrorCode = 'DECISION_ERROR') {
    super(message, code);
    this.name = 'DecisionError';
  }
}

/** A model that answers typed questions about a state with numbers, not text. */
export interface IDecisionModel {
  /** Configured model identifier, for logs. */
  readonly model?: string;
  decide(
    request: DecisionRequest,
    options?: CallOptions,
  ): Promise<Result<DecisionResult, DecisionError>>;
}
```

Rules carried by the contract (documented in TSDoc):

- `Result`, not throw — consistent with `ILlm`, `IReranker`, `IOutputValidator`.
- An implementation that cannot answer a question type returns
  `DECISION_UNSUPPORTED_QUESTION` for the whole request (*unsupported is an
  error*); it never drops or fakes an answer.
- Cancellation through `options.signal` yields `DECISION_ABORTED`, distinct
  from provider failure.
- `noul` is renamed `probability` and `legend` is not carried: the contract is
  vendor-neutral, and `legend` only echoes the request.
- Numeric invariants an implementation guarantees on `ok: true` (§5 item 4
  validates them for Jev): every probability and confidence is a finite number
  in `[0, 1]`; a `choice` is one of its question's labels and its
  `probabilities` cover exactly those labels; a `score` lies in
  `[0, levels − 1]` and its `probabilities` cover exactly `0 … levels − 1`.
  Consumers may rely on them without re-checking.

Additive edit: `LlmComponent` (`interfaces/request-logger.ts`) gains `'decision'`.
Consumers with an exhaustive `switch` over `LlmComponent` see a new case — noted
in the CHANGELOG.

## 5. Provider — `@mcp-abap-adt/typesafe-decision`

New package `packages/typesafe-decision/`, laid out like `packages/deepseek-llm/`
(`src/index.ts`, `src/typesafe-decision-model.ts`, `src/__tests__/`, README,
LICENSE + `GPL-3.0.txt`, `CHANGELOG.md`).

`package.json`: `"license": "LGPL-3.0-only"`, ESM, version in lockstep (30.1.0);
`dependencies: { "@typesafe-ai/sdk": "^0.6.0" }` (third-party, like `axios` in
`openai-llm`); `peerDependencies: { "@mcp-abap-adt/llm-agent": "^30.1.0",
"@mcp-abap-adt/interfaces-auth": "^2.1.0" }` — the same single ranges every
library uses (`test/repo/scoped-dependencies.test.ts` enforces it).

```ts
export interface TypeSafeDecisionConfig {
  /** Asked on every call, so a rotating key rotates. */
  credential: IApiKeyCredential;
  /** Unset → SDK default (`jev-latest`). */
  model?: string;
  /** Unset → `https://api.typesafe.ai`. */
  baseUrl?: string;
  /** Per-attempt timeout; unset → SDK default. */
  timeoutMs?: number;
  /** Unset → SDK default (2). */
  maxRetries?: number;
  /** Test seam; unset → global fetch. */
  fetch?: typeof fetch;
}
export class TypeSafeDecisionModel implements IDecisionModel { /* … */ }
```

Behaviour of `decide()`:

1. **A fresh `TypeSafeClient` per call**, constructed with explicit
   `apiKey: await credential.secret()`, `baseURL`, `defaultModel` and
   `logLevel: 'off'`. This is how rotation is honoured (the SDK freezes the key)
   and how environment fallbacks are kept out: with every option explicit,
   `TYPESAFE_*` variables are never consulted. The constructor only reads
   config; it opens no connection. `baseURL`/`defaultModel` pass the SDK's own
   default when unset in our config.
2. `timeout` and `retry.maxRetries` are passed **only when set** (*unset is not
   sent*). Retry/backoff/`Retry-After` and abort are the SDK's — we do not write
   a retry loop.
3. Request mapping: our `DecisionQuestion` → SDK question with the same `type`
   literal; `state`/`instructions`/`criteria` pass through. `options.signal` →
   SDK `signal`.
4. Response mapping: `noul` → `{ type: 'noul', probability }`; `choice` as is;
   `score` without `legend`, `probabilities` keys as numbers; `usage` →
   `{ inputTokens, outputTokens }`.
   **Validation** — the SDK types the response but does not check it at run
   time, so the provider does. Any of the following → `DECISION_ERROR` naming
   the key and the violated rule (never a partial result):
   - an answer missing for a requested key, or a `type` other than its
     question's;
   - `noul`: `probability` not a finite number in `[0, 1]`;
   - `choice`: `choice` not one of the question's labels; `confidence` not finite
     in `[0, 1]`; `probabilities` keys not exactly the question's labels, or a
     value not finite in `[0, 1]`;
   - `score`: `score` not finite in `[0, levels − 1]`; `confidence` not finite in
     `[0, 1]`; `probabilities` keys not exactly the integers `0 … levels − 1`, or
     a value not finite in `[0, 1]`.
   Probabilities are **not** required to sum to 1 (rounding); that is not
   checked.
5. Error mapping:

   | SDK error | `DecisionErrorCode` |
   |---|---|
   | `TypeSafeError` thrown before the request, `BadRequestError`, `UnprocessableEntityError`, `NotFoundError` | `DECISION_INVALID_REQUEST` |
   | `AuthenticationError`, `PermissionDeniedError` | `DECISION_AUTH` |
   | `RateLimitError` (after the SDK's retries) | `DECISION_RATE_LIMITED` |
   | `InternalServerError`, `APIConnectionError`, `APITimeoutError` | `DECISION_UNAVAILABLE` |
   | `APIUserAbortError` | `DECISION_ABORTED` |
   | anything else | `DECISION_ERROR` |

   Messages include the SDK `requestId` when present; they never include the
   key or the request body.

The package logs nothing; usage accounting is a decorator (§6.2).

## 6. Library — `@mcp-abap-adt/llm-agent-libs`

### 6.1 `DecisionReranker`

New `packages/llm-agent-libs/src/reranker/decision-reranker.ts`, exported next
to `LlmReranker` / `NoopReranker`.

```ts
export interface DecisionRerankerOptions {
  /** Override the default task wording (agnostic, no domain terms). The passage
   *  is always sent alongside it — this never replaces the passage. */
  task?: DecisionEntry;
  criteria?: { true?: DecisionEntry; false?: DecisionEntry };
}
export class DecisionReranker implements IReranker {
  constructor(model: IDecisionModel, options?: DecisionRerankerOptions);
  rerank(query: string, results: RagResult[], options?: CallOptions):
    Promise<Result<RagResult[], RagError>>;
}
```

- Empty `results` → returned unchanged, no call.
- One `decide()` per call: `state = query`; `questions = { r0 … r(N-1) }`, each a
  `noul` question with `instructions: { task: options.task ?? DEFAULT_TASK,
  passage: results[i].text }` — the passage is **always** present, the override
  replaces only the task — and `criteria: options.criteria ?? DEFAULT_CRITERIA`
  (true: "The passage contains information that helps answer the query", false:
  "The passage does not help answer the query"; `DEFAULT_TASK`: "Judge whether
  this passage helps answer the query given as the state"). Jev evaluates
  questions in parallel, so latency ≈ one question.
- Each result gets `score = answers['r' + i].probability` (in `[0, 1]`, the
  `RagResult.score` range); results are sorted by score descending, stable;
  `text` and `metadata` untouched.
- Any `DecisionError`, or a missing/mistyped answer → `{ ok: false, error: new
  RagError(<message>, 'RERANK_ERROR') }`; the message carries the decision code.
  `RerankHandler`'s existing fallback (original order) then applies.
- `DecisionReranker` is exported from the `llm-agent-libs` index next to
  `LlmReranker`; `wrapDecisionModel` likewise, next to `wrapEmbedder`.
- **Open quality question, settled by the live test (§9), not by guess:**
  "query as state, passages as questions" vs "query+passage as state, one call
  per passage". The first is chosen: one call, and the query is not repeated N
  times. The 64k/32k limits are not reached by a normal RAG top-k; if they are,
  the 400 maps to `DECISION_INVALID_REQUEST` → original order.

### 6.2 Usage accounting — `wrapDecisionModel`

New `packages/llm-agent-libs/src/adapters/usage-logging-decision-model.ts`,
modelled on `usage-logging-embedder.ts`:

```ts
export function wrapDecisionModel(inner: IDecisionModel): IDecisionModel;
```

On every **successful** `decide()` with `options.requestLogger` present:
`logLlmCall({ component: 'decision', model: result.model, promptTokens:
usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: sum,
durationMs: measured, scope: 'request', requestId: options.trace?.traceId })`.
Without `usage`, tokens are estimated (`ceil(chars / 4)` over the serialised
request, `completionTokens: 0`) and the entry carries `estimated: true`.
No `requestLogger` → no-op. Idempotent: wrapping an already-wrapped model returns
it (brand symbol, as the embedder wrapper does).

### 6.3 `RerankHandler` — make failure visible

`packages/llm-agent-libs/src/pipeline/handlers/rerank.ts` keeps its behaviour
(fallback to the original order) and adds, when `!rr.ok`:

- `span.setAttribute(\`${name}.rerank_error\`, rr.error.code)`;
- `ctx.options?.sessionLogger?.logStep('rerank_error', { store: name, code,
  message })`.

Reason: with a decision-backed reranker, a stale key means reranking *never*
runs, and today nothing records that.

## 7. SmartServer — `@mcp-abap-adt/llm-agent-server-libs`

### 7.1 Configuration

> **Superseded in part by §13.** The `reranker:` section below and
> `SmartServerRerankerConfig` are removed before release (nothing was published);
> `decision:` stays as written.

```yaml
decision:
  provider: typesafe
  model: jev-latest        # optional
  credentialRef: TYPESAFE  # optional; default ref DECISION → DECISION_API_KEY
  baseUrl: https://…       # optional
  timeoutMs: 10000         # optional
  maxRetries: 2            # optional
reranker:
  type: decision           # uses the `decision:` model
```

New types next to the other section types:

```ts
export interface SmartServerDecisionConfig {
  provider: 'typesafe';
  model?: string;
  credentialRef?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}
export interface SmartServerRerankerConfig {
  type: 'decision';
}
// SmartServerConfig gains:
decision?: SmartServerDecisionConfig;
reranker?: SmartServerRerankerConfig;
```

**Resolution into the runtime config.** `resolveSmartServerConfig()`
(`config.ts`) builds `SmartServerConfig` from an explicit list of fields, with
the per-section work in `resolve-config-sections.ts` (`resolveLlmSection`, …).
Two resolvers are added there and listed in `resolveSmartServerConfig`:

- `resolveDecisionSection(yaml)` → `SmartServerDecisionConfig | undefined`:
  `undefined` when `decision:` is absent; otherwise named fields only
  (`provider`, `model`, `credentialRef`, `baseUrl`, `timeoutMs`, `maxRetries`).
  An optional field absent in YAML is **absent** in the result (no `undefined`
  key, no default filled in — *unset is not sent*), and a present falsy value is
  kept as is: `maxRetries: 0` stays `0` (it disables the SDK's retries).
- `resolveRerankerSection(yaml)` → `SmartServerRerankerConfig | undefined`, same
  rules.

Both are spread conditionally into `resolved` (`...(x ? { decision: x } : {})`),
like `skills`. `apiKey` is not copied — the validator rejects it from the raw
YAML (below), exactly as it does for `llm`.

`config-validator.ts` additions — checked on the **raw YAML**
(`validateResolvedConfig` already reads `get(yaml, 'llm')`), each an issue that
fails startup:

- `decision.provider` missing or not `typesafe`;
- `decision.credentialRef` present but empty (reuse `checkCredentialRef`);
- `decision.apiKey` present — the same "secrets are no longer read from
  configuration" message `checkLlmRole` emits today; that check is inline there,
  so it is extracted into a small `checkNoSecret(label, section, issues)` used by
  both (behaviour of `checkLlmRole` unchanged);
- `decision.timeoutMs` / `decision.maxRetries` not a positive / non-negative
  integer;
- `reranker.type` not `decision`;
- `reranker.type: decision` without a `decision:` section.

### 7.2 Composition seam

`BuildAgentDeps` gains an **optional** seam:

```ts
makeDecisionModel?: (cfg: SmartServerDecisionConfig) => Promise<IDecisionModel>;
```

Optional so existing consumers of `BuildAgentDeps` keep compiling. A `decision:`
section with no `makeDecisionModel` seam is a startup error naming the seam.
The server wraps whatever the seam returns in `wrapDecisionModel`.

### 7.3 Reranker resolution — a small module

> **Superseded in part by §13.** `resolveReranker` keeps only the plugin branch
> (a plugin / `withReranker` reranker for the `rerank` stage); the YAML
> `reranker.type: decision` branch is replaced by `rag.retrieval` (§13.4).

`smart-server.ts` is already several thousand lines (principle 6), so the logic
goes into a new `packages/llm-agent-server-libs/src/smart-agent/resolve-reranker.ts`,
modelled on `resolve-agent-embedder.ts`:

```ts
export async function resolveReranker(input: {
  rerankerCfg?: SmartServerRerankerConfig;
  decisionCfg?: SmartServerDecisionConfig;
  makeDecisionModel?: BuildAgentDeps['makeDecisionModel'];
  pluginReranker?: IReranker;
}): Promise<IReranker | undefined>;
```

- YAML `reranker` **and** a plugin reranker → error (configuration said
  something; it is never silently ignored).
- YAML `reranker.type: decision` → `new DecisionReranker(wrapDecisionModel(await
  makeDecisionModel(decisionCfg)))`.
- Only a plugin reranker → it (today's behaviour).
- Neither → `undefined` (the agent's `NoopReranker` default).

A `decision:` section without a `reranker:` is valid (the model is built only
when a consumer asks for it — today, only the reranker); it is not built eagerly.

### 7.4 The reranker must reach the per-session agent

Requests are served by the **per-session** agent, not the startup one: the
startup agent "exists purely for infrastructure" (comment at
`smart-server.ts:1563`), and `_handleChat` dispatches to `graph.agent`, built by
`buildSessionAgent → buildPipelineInstance → buildServerCtx.createAgentBuilder →
buildBaseBuilder(partsToBaseInput(parts, registry, extras))`. On that path
`applyServerExtras` is `false` (`partsToBaseInput`, `?? false`), and today's
`withReranker(plugins.reranker)` sits inside `if (parts.applyServerExtras)`
(around line 2740). So a reranker wired only there never runs on a real request
— that is already true of today's plugin reranker.

Therefore:

- `resolveReranker(...)` runs **once** in `_buildInfra()` — the infra build
  shared by the HTTP path (`start()` → `_start()` → `_buildInfra()`) and the
  embeddable path (`buildAgent()` → `_buildEmbeddedAgent()` → `_buildInfra()`) —
  right after `pluginLoader.load()` and the explicit `plugins: […]` merge, and
  before the first `buildBaseBuilder` call. Placing it in `start()` would leave
  the embedded agent without a reranker. The result is kept in a hoisted field
  `this._reranker?: IReranker`, next to `_mainLlm` / `_helperLlm` (the globals
  `buildSessionAgent` re-wires from). One
  instance serves all sessions: `DecisionReranker` holds no per-request state, and
  per-request accounting travels in `CallOptions.requestLogger`.
- `buildBaseBuilder` applies `builder.withReranker(this._reranker)` **outside**
  the `applyServerExtras` gate, so the startup and every session builder get the
  same reranker. The old `if (plugins?.reranker)` line inside the gate is removed.
- Consequence for plugin users: a plugin reranker now actually runs on requests.
  This is a fix of a silent no-op, recorded under *Fixed* in the CHANGELOG.
- Out of scope, reported separately as an issue: `queryExpander` and
  `outputValidator` sit in the same gate and have the same defect.

Required test (`smart-server` level, not just `resolveReranker`): YAML with
`decision:` + `reranker: {type: decision}` and a fake `makeDecisionModel`
recording calls → start the server → send a chat request that hits RAG on the
flat pipeline with a session → assert the fake model's `decide()` was called
with the query as `state`. The same test with a plugin reranker asserts the
plugin is called (the fix). The test starts from **YAML text through the real
`resolveSmartServerConfig`**, not from a hand-built `SmartServerConfig`, so the
resolver of §7.1 is on the path. A twin test covers the embeddable path:
`buildAgent(cfg, deps)` from the same YAML → one chat call → the fake model is
called.

`decision:` and `reranker:` are not hot-reloadable (`HotReloadableConfig` carries
agent knobs only, as for `llm:` / `rag:`); a change takes a restart.

## 8. Binary — `@mcp-abap-adt/llm-agent-server`

- New `packages/llm-agent-server/src/composition/make-decision-model.ts`:
  `createMakeDecisionModel(lookup, ctors = SHIPPED_DECISION_PROVIDERS)`,
  mirroring `make-llm.ts`.
  - `DEFAULT_DECISION_REF = 'DECISION'` added to `credential-for.ts`.
  - The resolved entry must hold an `api-key` credential; otherwise an error
    naming the ref and the expected variable (`<REF>_API_KEY`).
  - The provider config is built from **named** fields — nothing spreads `cfg` —
    so `credentialRef` cannot ride into the provider.
- `composition/index.ts` adds `makeDecisionModel` to what
  `buildCompositionDeps(env)` returns.
- `@mcp-abap-adt/typesafe-decision` becomes a regular dependency of
  `@mcp-abap-adt/llm-agent-server`, like the LLM providers.

### 8.1 Build graph

A `package.json` dependency is not enough: the repo builds with `tsc -b` from
explicit lists. All of these name the new package:

- `packages/typesafe-decision/tsconfig.json` — extends `../../tsconfig.base.json`
  like `deepseek-llm`, `references: [{ "path": "../llm-agent" }]`;
- root `package.json` `build` and `clean` (`tsc -b …` / `tsc -b --clean …`) —
  `packages/typesafe-decision` after `packages/llm-agent`, before
  `packages/llm-agent-server`;
- `packages/llm-agent-server/tsconfig.json` `references` —
  `{ "path": "../typesafe-decision" }`;
- `tsconfig.typecheck.json` `include` — the provider's credential test, as for the
  other providers' `credential.test.ts`;
- `scripts/publish-all.sh` — see §11.

`llm-agent-libs` and `llm-agent-server-libs` need no new reference: they consume
only `@mcp-abap-adt/llm-agent` (already referenced) for the contract, and
`server-libs` gets `DecisionReranker` / `wrapDecisionModel` from `llm-agent-libs`
(already referenced). CI workflows hold no package list (`npm ci` → `build` →
`typecheck` → `test`).

**Clean-checkout check** before the PR is declared ready: a fresh `git worktree`
of the branch with no `dist/` anywhere → `npm ci && npm run build && npm run
typecheck && npm test` passes. This is what catches a missing reference that an
incremental local build (stale `dist/`, `.tsbuildinfo`) hides.

## 9. Testing

TDD; Node built-in runner; every package's `npm test`.

| Unit | What is asserted |
|---|---|
| `llm-agent` contract | `DecisionError` name/code/default code; index exports |
| `typesafe-decision` (injected `fetch`) | request body shape per question type; response mapping incl. `noul→probability`, no `legend`, numeric score keys, usage; every row of the error table; `secret()` called on each `decide()` (rotation); with `TYPESAFE_API_KEY`/`TYPESAFE_BASE_URL`/`TYPESAFE_DEFAULT_MODEL` set to sentinels, none of them reaches the request; unset `timeoutMs`/`maxRetries` not passed; missing / mistyped answer → `DECISION_ERROR`; every validation rule of §5 item 4 rejected with `DECISION_ERROR` (absent, string, `NaN`, `Infinity`, negative and > 1 probability/confidence; unknown choice label; label-set mismatch; score out of `[0, levels − 1]`; non-integer or missing score keys), and boundary values `0` / `1` accepted; abort → `DECISION_ABORTED` |
| `DecisionReranker` | empty input → no call; question construction; sort by probability, stable; `task` override keeps every passage — each `r<i>` question carries `results[i].text` and the override task; `criteria` override; error and missing-key paths → `RERANK_ERROR` |
| `wrapDecisionModel` | entry fields; estimate path; no logger → no-op; failure → no entry; idempotent wrap |
| `RerankHandler` | failure sets span attribute + session step, still falls back |
| config validator | every issue in §7.1 |
| `resolveDecisionSection` / `resolveRerankerSection` | absent section → `undefined`; absent optional fields stay absent (no `undefined` keys); `maxRetries: 0` and `timeoutMs` preserved; `apiKey` not copied |
| `resolveReranker` | all four branches incl. the YAML+plugin conflict and missing seam |
| `SmartServer` session path (§7.4) | from YAML text through `resolveSmartServerConfig`: an HTTP chat request on a session reaches the fake decision model; the embeddable `buildAgent()` path likewise; a plugin reranker reaches the session agent (regression for the gated wiring) |
| binary composition | default ref `DECISION`; non-api-key credential refused; named-field config (no `credentialRef` leak) |
| repo tests | `licensing.test.ts`, `scoped-dependencies.test.ts`, `readme-badges.test.ts` pass with the new package |

Integration (not in `npm test`): `test/integration/typesafe-decision/`, gated on
`DECISION_API_KEY` (pattern of the integration-test-env-gates skill): one live
`decide()` per question type; and a rerank check — a query with one clearly
relevant and several irrelevant passages, asserting the relevant one ranks
first. This is where §6.1's open quality question is answered.

CI matrix (Node 22/24/26): the gate is run on each leg before the PR is
declared green.

## 10. Documentation (whole set, before release)

- `README.md` — package list (19th package), the decision-model capability.
- `docs/ARCHITECTURE.md` — layer table, `IDecisionModel` next to `ILlm` /
  `IEmbedder`, the reranker seam.
- `docs/EXAMPLES.md` — the YAML of §7.1; programmatic `DecisionReranker` with
  `SmartAgentBuilder.withReranker`.
- `docs/INTEGRATION.md` — implementing your own `IDecisionModel`.
- `docs/QUICK_START.md`, `.env.template` — `DECISION_API_KEY`.
- `docs/PERFORMANCE.md`, `docs/DEPLOYMENT.md` — reranking sections updated.
- `docs/TROUBLESHOOTING.md` — "reranking has no effect" → `<store>.rerank_error`
  span attribute / `rerank_error` session step.
- `docs/SECURITY_THREAT_MODEL.md` — new outbound data flow: with
  `reranker.type: decision`, the user query and retrieved passages are sent to
  TypeSafe's API (a third party).
- `packages/typesafe-decision/README.md` (+ License section), `CHANGELOG.md`
  (incl. the `LlmComponent` note and, under *Fixed*, the plugin reranker
  now reaching session agents), `CLAUDE.md` (package list and env table).

No migration guide: nothing breaks.

## 11. Release

- Version **30.1.0** for every package (lockstep, `node
  scripts/bump-version.mjs 30.1.0`); publish is the user's (`release:publish`).
- Dependency hygiene (relaxed same-repo rule, agreed 2026-10-02): workspace links
  between this repo's packages are fine during development. Before tagging:
  every `package.json` in the release has only semver ranges (no `file:`,
  `link:`, `workspace:`), every range resolves on the registry in publish order
  (`llm-agent` → `typesafe-decision` / `llm-agent-libs` → `llm-agent-server-libs`
  → `llm-agent-server`), and `@typesafe-ai/sdk` in `package-lock.json` resolves
  from the registry. After publishing: a clean install of
  `@mcp-abap-adt/llm-agent-server@30.1.0` from the registry in a temp dir.
- `scripts/publish-all.sh` publishes from an explicit `PACKAGES=( … )` list
  (`bump-version.mjs` discovers packages itself, the publish script does not):
  add `typesafe-decision` right after `pg-vector-rag` — after `llm-agent`, before
  `llm-agent-libs` / `llm-agent-server-libs` / `llm-agent-server`.

## 12. Architecture-principle check

1. **Build on existing components** — the reranker seam (`IReranker`,
   `withReranker`, `RerankHandler`), the credential lookup, the embedder usage
   wrapper pattern and the SDK's own retry are reused; nothing bespoke in the app.
2. **The app is the example** — SmartServer gets the capability through YAML and
   a seam, exactly as `llm` and `rag.embedder`.
3. **Interfaces** — consumers depend on `IDecisionModel` / `IReranker`, never on
   `TypeSafeDecisionModel`.
4. **ISP** — a new small interface; `ILlm` and `IReranker` are not grown.
   Health/model listing is left to a future separate interface.
5. **Strategies** — the provider is swappable through the seam; the reranker's
   task and criteria wording are overridable (the passage always stays).
6. **File size** — new logic in small modules; `smart-server.ts` changes by one
   call site.
7. **Don't break** — all additions are optional. Visible changes: the new
   `LlmComponent` literal, failure telemetry in `RerankHandler`, and a plugin
   reranker now running on session requests (a fix of a silent no-op, §7.4).

## 13. Addendum A — per-store retrieval strategies (2026-10-04)

### 13.1 Why

1. **The reranker reached only one of three tool-selection paths.** Tool
   candidates are chosen by (a) the flat stages `rag-tools → rerank → tool-select`
   (flat, linear, dag workers), (b) `IToolsRagHandle.query(text, k)` — the
   controller per step (`selectTools(step.instructions, 20)`) and every stepper
   mode, with no strategy and no reranker, and (c) the `tool-loop` per-iteration
   re-select, also with neither. The `rerank` stage covers (a) only.
2. **One question does not fit every store.** Knowledge asks "does this passage
   help answer the request?"; tools ask "will calling this tool help carry out
   the request?"; history should not leave the deployment at all by default.
3. **The consumer — and our own apps — must choose** per store between plain
   embedding retrieval and reranking, and be able to add their own way.
4. **Measured value.** Live spike on the `mcp-abap-adt` 15.0.0 catalog (218
   tools, `readonly,high`), 30 English queries, embedder `text-embedding-ada-002`:
   embedding R@1 0.53 / R@3 0.80 / MRR 0.678 → Jev rerank of the top 15–30
   R@1 0.90 / R@3 0.97 / MRR 0.933, 13 better, 0 worse. Pool 15 vs 30 and the
   tool vs passage wording gave the same numbers on this set. One miss was
   embedding recall (`GetDdl` absent from the top 30 — a tool-description defect,
   fr0ster/mcp-abap-adt#270).

### 13.2 Contract — `@mcp-abap-adt/llm-agent` (additive)

```ts
/** How a store turns a query into its top-k results. The consumer's choice, per store. */
export interface IRetrievalStrategy {
  readonly name: string;
  retrieve(
    store: IRag,
    query: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>>;
}
```

`IQueryEmbedding.text` carries the query text, so a strategy can rerank without
any pipeline knowing about it. `IRag` (`query`, `healthCheck`, `getById`,
optional `writer()`) is not changed.

### 13.3 Library — `@mcp-abap-adt/llm-agent-libs`

Each in its own small module under `src/retrieval/`:

| Unit | Behaviour |
|---|---|
| `EmbeddingRetrieval` | `store.query(q, k, options)` — today's behaviour; the default |
| `RerankedRetrieval(reranker, { overfetch = 2 })` | `store.query(q, k × overfetch)` → `reranker.rerank(q.text, candidates)` → top-k |
| `RerankAllRetrieval(reranker, { maxCandidates })` | `store.query(q, maxCandidates)` → rerank all → top-k. `maxCandidates` is configured, never derived from an assumed catalog size |
| `StrategyRag(inner, strategy)` implements `IRag` | `query` → `strategy.retrieve(inner, …)`; `healthCheck`, `getById`, `writer()` delegate to `inner` unchanged (catalog vectorization keeps working) |
| `applyRetrievalStrategy(rag, strategy)` | wraps **every explicitly configured** store — `EmbeddingRetrieval` included — in `StrategyRag`, branded, so `hasRetrievalStrategy(rag)` is true (an explicit `embedding` must be distinguishable from "not configured", see *Precedence*). Returns `rag` unchanged when `hasRetrievalStrategy(rag)` is already true (idempotent) |
| `IRagDecorator { readonly inner: IRag }` | new optional capability (ISP): a store that wraps another exposes it. `StrategyRag` and `FallbackRag` implement it. `hasRetrievalStrategy` walks the `inner` chain, so an outer decorator — e.g. the circuit breaker's `FallbackRag` (`builder.ts:975-990`) — never hides the brand |

**Batching.** Both reranked strategies send candidates in batches:
- `DecisionReranker` batches by an estimated token budget (≈ chars / 4) under
  Jev's request limit (64k total; 32k for state + longest question), with
  headroom; Jev answers per question independently, so batch results merge by a
  plain sort;
- `LlmReranker` batches by candidate count.
Batches run with bounded concurrency (rate limits). A failed batch fails the
call.

**Failure → embedding order.** Any reranker failure (decision error, 429,
invalid LLM output, timeout) makes the strategy return the embedding ranking's
top-k — the request never fails because of reranking — and records a session
step `retrieval_rerank_error { store, strategy, code }` via
`options.sessionLogger`.

**Questions per store.** `DecisionReranker` already takes `task` / `criteria`
(§6.1). Two presets are exported: `TOOL_QUESTION` ("Judge whether calling this
tool would help carry out the request given as the state.") and
`PASSAGE_QUESTION` (today's default). The tool records' passage is the indexed
text `Tool: <name> — <description>` (no input schema).

**Builder.** `SmartAgentBuilder.withRetrievalStrategy(store: string, strategy:
IRetrievalStrategy)` records the strategy. The builder applies it **when it
projects registry entries into `ragStores`** (`builder.ts:926-946`): each
projected store whose key has a strategy is passed through
`applyRetrievalStrategy`. The registry itself is never mutated, so this works
with any `IRagRegistry` — the public interface has no `replaceRag`, and the
builder's own projection already treats `setMutationListener` as an optional,
duck-typed capability (`builder.ts:940-946`):

- a registry with `setMutationListener` (incl. `SimpleRagRegistry`): the
  projection is rebuilt on every change, so a collection registered after build
  is projected — and wrapped — like the rest;
- a custom registry without it: a collection registered after build is not
  projected at all (pre-existing behaviour, unchanged), so no pipeline stage can
  query it — the strategy's coverage equals what the pipeline can see. This is
  documented next to `withRetrievalStrategy`.

**Precedence.** An explicit per-store strategy wins over the global reranker
(plugin / `withReranker`): `RerankHandler` skips every store for which
`hasRetrievalStrategy` is true — including one configured as `embedding`, so
`history: { strategy: embedding }` is never reranked or sent out, whatever else
is wired. A store with no `rag.retrieval` entry keeps today's behaviour (the
global reranker, if any, reranks it in the `rerank` stage).

**Wrapper order and single application.** There are two application points:
the server, at creation of `tools` / `history` (so `makeToolsRagHandle` gets the
wrapped instance), and the builder's projection (everything the pipeline
reads). The circuit breaker's `FallbackRag` may sit in between, so the order is
either `FallbackRag(StrategyRag(store))` (server-wrapped stores) or
`StrategyRag(FallbackRag(store))` (projected collections). Both are fine:
`hasRetrievalStrategy` walks `IRagDecorator.inner`, so the second application
point sees the brand and returns the store unchanged — one rerank per query.

With the circuit **open**, the two orders behave differently, and both are
accepted (the request never fails). `FallbackRag.writer()` fans writes out to
the fallback store too (`fallback-rag.ts:4, 52-54`), so the fallback is **not**
empty — it holds what was written, e.g. the vectorized tool catalog:

| Order | Circuit open |
|---|---|
| `FallbackRag(StrategyRag(store))` — `tools` / `history` wrapped by the server, as seen by the pipeline | `FallbackRag` queries its fallback directly: **the reranker is bypassed**, results are the fallback's own ranking |
| `StrategyRag(FallbackRag(store))` — collections wrapped in the projection | the strategy reranks the **fallback's** results |

(`makeToolsRagHandle` holds the server-wrapped `StrategyRag(tools)` with no
`FallbackRag` around it, so the controller / stepper path is not affected by the
breaker either way.) The difference is documented in TROUBLESHOOTING next to
the circuit-breaker entry.

### 13.4 Configuration and server wiring

```yaml
decision: { provider: typesafe }        # unchanged (§7.1)
llm:
  main:     { provider: sap-ai-sdk, model: gpt-5 }
  reranker: { provider: sap-ai-sdk, model: gpt-4.1-mini }   # only for reranker: llm
rag:
  store: { … }
  embedder: { … }
  retrieval:                             # per store; a store not listed → embedding
    tools:     { strategy: rerank, reranker: decision, overfetch: 2 }
    knowledge: { strategy: rerank-all, reranker: llm, llm: reranker, maxCandidates: 200 }
```

- Keys are store keys as the pipeline's `ragStores` projection names them
  (`builder.ts:926-936`): `tools`, `history`, a global collection's bare name,
  `user/<name>` and `session/<name>` for user- and session-scoped collections.
- `strategy: embedding | rerank | rerank-all` (default `embedding`).
- `reranker: decision | llm` — required for `rerank` / `rerank-all`. `decision`
  needs the `decision:` section (and the `makeDecisionModel` seam); `llm` needs
  `llm: <key>` naming an entry of the `llm:` map.
- `question: tool | passage` — default `tool` for the `tools` store, `passage`
  otherwise; `task` (string) overrides the wording outright.
- `overfetch` (positive integer, default 2) for `rerank`; `maxCandidates`
  (positive integer, required) for `rerank-all`. `${VAR}` strings are accepted
  through `parseIntegerField` (§7.1).
- Validation on the raw YAML, as in §7.1: unknown strategy / reranker / question;
  `reranker` missing for a reranked strategy; `decision` reranker without
  `decision:`; `llm` reranker without `llm:` or naming an absent key;
  `maxCandidates` missing for `rerank-all`; `retrieval` key that is not a mapping.
- **Removed (unreleased):** the `reranker:` section, `SmartServerRerankerConfig`,
  and the YAML branch of `resolveReranker`.

**Server.** Stores reach the pipeline two ways, and both get the strategy:

- **Built by the server through the `makeRag` seam** — `tools` and `history` in
  `_buildInfra` (`smart-server.ts:1450-1451`) and the worker stores (`:2060`,
  `:2071`). Each passes through one helper that applies the strategy configured
  for its key (`tools` / `history`) at creation. `rag.retrieval` is
  **server-wide**: worker stores use the main config's map by key, and a worker
  config that declares its own `rag.retrieval` is rejected at startup
  ("strategies are server-wide — set them in the main config's
  rag.retrieval"), never silently ignored. Per-worker overrides can be added
  later without breaking this. The same wrapped `tools` instance is what the flat stages,
  `tool-loop`, and `makeToolsRagHandle` (`:2487`, controller and stepper)
  receive, so all three selection paths of §13.1 use it.
- **`CallOptions` reach the strategy on every path.** `rag-query`
  (`rag-query.ts:97`), `tool-loop` (`tool-loop.ts:350`) and `FallbackRag`
  already pass `options`; `IToolsRagHandle.query(text, k, options)` does not —
  it calls `toolsRag.query(embedding, limit)` (`tools-rag-handle.ts:62`). It is
  changed to forward `options`, so a reranker on the controller / stepper path
  gets `signal` (cancellation), `requestLogger` (usage) and `sessionLogger`
  (`retrieval_rerank_error`). `StrategyRag` passes `options` to the strategy,
  and the strategies pass them to the reranker.
- **Named collections** are not built there: they enter the per-session registry
  from the deployment globals and the RAG providers (`buildSessionRagRegistry`,
  `session-rag-registry.ts`) and reach the pipeline through the builder's
  `ragStores` projection of the registry (`builder.ts:926-936`). The server
  passes one `withRetrievalStrategy` per configured key; the builder applies it
  in that projection (see *Builder* in §13.3).

Rerankers are resolved once in `_buildInfra`; decision-backed ones are wrapped
in `wrapDecisionModel`.

**`agent.toolSelection` gate.** Like the reranker before §7.4, the
`withToolSelectionStrategy` call sits inside `if (parts.applyServerExtras)`
(`smart-server.ts:2781` → `:2821`), so per-session agents never get it. It is
resolved once and applied outside the gate. With a reranked `tools` store,
`minScore` compares against reranker probabilities in `[0, 1]`, not cosine —
documented.

### 13.5 `LlmReranker` rework

- Per-store question (`TOOL_QUESTION` / `PASSAGE_QUESTION` / custom `task`).
- Output contract: the whole reply (trimmed; one surrounding ```` ```json ```` /
  ```` ``` ```` fence is unwrapped) must parse with `JSON.parse` as an array of N
  numbers in `[0, 1]`, one per candidate, in order. Prose around the array, two
  arrays, wrong length, a non-finite value or a value outside `[0, 1]` →
  `RagError('RERANK_ERROR')` (→ embedding order via §13.3), never zero-filled.
- Batches by candidate count; usage logged through the request logger under its
  own component.
- `withReranker(new LlmReranker(llm))` keeps working (same `IReranker`).

### 13.6 Testing

- Unit: each strategy (ordering, top-k, overfetch, `maxCandidates`), batching
  (token budget boundary, merge order), failure → embedding order + session step,
  `StrategyRag` delegation of `healthCheck` / `getById` / `writer()`,
  `applyRetrievalStrategy` — the first application wraps (an explicit `embedding`
  included) and brands, a second application returns the same wrapper (also
  through a `FallbackRag`), `RerankHandler` skip,
  `LlmReranker` output contract, resolver + validator for every rule in §13.4.
- Server (YAML through the real `resolveSmartServerConfig`): a controller run's
  per-step `selectTools` goes through the `tools` strategy **and the reranker
  receives the request's `signal`, `requestLogger` and `sessionLogger`**; the
  flat path too; a store not listed stays on embedding; `agent.toolSelection`
  reaches a session agent.
- Precedence: `history: { strategy: embedding }` + a plugin / `withReranker`
  reranker → the plugin reranker is never called for `history`; an unlisted
  store is still reranked by it.
- Wrapper order: circuit breaker on + `tools: { strategy: rerank }` → exactly
  one reranker call per query (`FallbackRag(StrategyRag)` is detected through
  `IRagDecorator.inner`); a projected collection under the breaker
  (`StrategyRag(FallbackRag)`) is also reranked once.
- Circuit open with a **non-empty** fallback (records written through
  `FallbackRag.writer()`): `FallbackRag(StrategyRag)` returns the fallback's
  results without calling the reranker; `StrategyRag(FallbackRag)` reranks the
  fallback's results — one call.
- Custom registry: an `IRagRegistry` that is not `SimpleRagRegistry` but has
  `setMutationListener` → a collection registered after build is projected and
  goes through its strategy; one without it → the collection is not projected
  (documented pre-existing behaviour), and nothing throws.
- **Quality eval, committed (env-gated, not `npm test`):** `scripts/rag-eval`
  gains `--retrieval embedding|rerank|rerank-all` and `--reranker decision|llm`,
  reporting R@1/3/5, MRR and better/worse per case. The `mcp-abap-adt` 15.0.0
  catalog snapshot (218 tools — public names and descriptions only, no system
  data) and the 30 queries with `Read*`→`Get*` corrected are committed beside the
  existing 63-tool snapshot.

### 13.7 Out of scope

- Cohere Rerank on SAP AI Core: listed in the tenant's catalog
  (`cohere-reranker`, `cohere-rerank-pro`) but not deployed, so its API cannot be
  verified; `reranker:` leaves room for it.

### 13.8 Architecture-principle check

1. Built on existing components: `IRag`, `IReranker`, `DecisionReranker`,
   `LlmReranker`, the `makeRag` seam; no pipeline-specific glue.
2. The app is the example: SmartServer chooses per store through YAML.
3. Interfaces: consumers depend on `IRetrievalStrategy` / `IRag`.
4. ISP: new small interfaces (`IRetrievalStrategy`, the optional `IRagDecorator`
   capability); `IRag`, `IReranker`, `IToolSelectionStrategy` are not grown.
5. Strategy: retrieval per store is the consumer's choice, built-ins or their own.
6. File size: new logic in `src/retrieval/*` modules; `smart-server.ts` gets one
   helper call per store creation site plus the gate move.
7. Additive for released contracts; the only removals are the unreleased
   `reranker:` YAML and `SmartServerRerankerConfig`.

## 14. Addendum B — session agents get the server's wiring (2026-10-04)

### 14.1 Why

Every request is served by a **per-session agent** (`buildSessionAgent` →
`buildPipelineInstance` → `buildBaseBuilder` with `applyServerExtras: false`).
Part 2 found that this gate had already dropped the reranker and
`agent.toolSelection` from session agents (§13.4). An investigation of the
whole gate (2026-10-04) found more silent losses. Git history shows the gate was
incidental: `084ccbb1` built the session agent minimal, and `62531b0c` "preserve
behavior" only kept that minimal shape. No test pins the gated behaviour.

| Wiring | Session agents today | Effect |
|---|---|---|
| plugin `outputValidator` | not applied | plugin validator ignored on every request |
| skill manager (DI > plugin > YAML `skills:`) | not applied | `skill-select` is a no-op; skills never injected |
| `agent.llmCallStrategy` | not applied | requests always stream, whatever the YAML says |
| circuit breaker | partly | stores are wrapped (the registry copies the wrapped globals); the LLM breaker never sees request traffic, so `/health` cannot report an LLM outage |
| `historyRag` | `undefined` | session summaries are written to the global `history` store and never read; with `historyAutoSummarizeLimit` the builder silently creates a per-session `InMemoryRag` instead |
| plugin `queryExpander`, client adapters | not applied | dead on **every** agent, startup included: #323, #324 |
| YAML `mcp:` auto-connect fallback | not applied | deliberate: one connection, made at startup |

Four neighbouring defects are fixed with them:
- **No cancellation.** The chat route (`http/chat-route-handler.ts`) and the
  adapter route (`http/adapter-route-handler.ts`) pass no `AbortSignal` to
  `process` / `streamProcess`. A client disconnect is never detected, so the
  request runs to the end and spends LLM, reranker and MCP calls. The stack below
  honours `CallOptions.signal` when it gets one.
- **`mergeSignals` leaks listeners** (`llm-agent-libs/src/agent.ts:235`). It
  never removes the `abort` listeners it adds to long-lived signals.
- **History summaries lack the answer.** `HistoryUpsertHandler` builds the turn
  with `assistantText: ''` (`pipeline/handlers/history-upsert.ts:98`), so a
  summary describes the question only.
- **A typo in a `rag.retrieval` store key is silent** (e.g. `tool:` for
  `tools:`).

### 14.2 Session-agent wiring

`_buildInfra` resolves each item **once** and `buildBaseBuilder` applies it
**outside** the `applyServerExtras` gate, so the startup agent and every session
agent get the same instance:

- **`outputValidator`** (plugin): the one instance, which is stateless.
- **`queryExpander`** (plugin) and **client adapters** (DI > plugin > default
  `ClineClientAdapter`): the same move. It is wiring only and changes nothing
  until #323 / #324 make the features work. After that, they work on the agents
  that serve requests.
- **Skill manager**: the one instance. Skill **vectorization** into the tools
  store stays startup-only. A session build must not re-upsert every skill into
  the shared tools store. The builder gets an additive way to skip
  vectorization (`withSkillManager(manager, { vectorize: false })`; default
  `true`, unchanged behaviour).
- **`agent.llmCallStrategy`**: resolved once to one `ILlmCallStrategy`
  instance and applied to every agent.
- **Circuit breaker**: **shared, not rebuilt per session**, and placed where
  **every** LLM is resolved, not only in the builder. A per-session breaker
  would split the failure count and double-wrap the copied stores. A
  builder-only LLM breaker would miss the role LLMs: the controller and the
  stepper take theirs from `ctx.resolveLlm` / `ctx.resolveNamedLlm`
  (`resolveRoleLlm` / `resolveNamedRoleLlm`), and the controller builds its
  handler before any builder runs. So:
  - **LLMs:** every LLM the role resolver (`IRoleLlmResolver`,
    `smart-agent/llm/role-llm-resolver.ts`) can return is wrapped in
    `CircuitBreakerLlm` where it is created: the held main / classifier /
    helper at their assignment (startup and `PUT /v1/config`), and each per-key
    `entry` build through an additive optional `wrap` hook in the resolver's
    deps. `resolve` / `resolveNamed` keep their signatures. There is **one breaker
    per `llm:` entry key**, so a failing model does not block a healthy one.
    The breaker is created once and reused by every session and every role that
    resolves that key. Wrappers are cached **by key**, not by instance: one
    object under two keys gets two breakers. An entry swapped by
    `PUT /v1/config` gets a fresh breaker, also when it swaps back to an
    instance used before. An LLM that already is a `CircuitBreakerLlm` (the
    consumer's own) is not wrapped again; its breaker takes the key's place, so
    `/health` reports the breaker that actually guards the key. The main, classifier and helper LLMs given to the builders are the
    wrapped instances, so the builders never wrap an LLM again.
  - **Stores / embedder:** SmartServer creates one embedder breaker from
    `circuitBreaker:`. `FallbackRag` only reads a breaker's state, so the
    breaker must also **see the embedding calls**: the server's retrieval
    embedder is wrapped with `withCircuitBreaker(embedder, breaker)` below the
    document/query role (each half before `symmetricEmbedder` /
    `asymmetricEmbedder` joins them), which keeps both halves and the batch
    capability. Until now no server path fed that breaker. Worker embedders
    keep no breaker, as today. An additive builder seam takes it
    (`withCircuitBreakers({ embedder })`; `withCircuitBreaker(config)` is
    unchanged and still builds its own LLM and embedder breakers for library
    consumers). The builder wraps no store already guarded by a `FallbackRag`
    on the same breaker; this needs `FallbackRag` to expose its breaker
    read-only, which is additive.
  - `/health` reports all of them: the per-key LLM breakers and the embedder
    breaker. Request traffic of every pipeline, the controller and the stepper
    included, now moves them.
  - **A cancellation is not a failure** (§14.4).
  - **Retries count once.** A breaker records one result per logical call:
    `RetryLlm` sits **inside** the breaker (`CircuitBreakerLlm → RetryLlm →
    adapter`), which is what `retry-llm.ts` and ARCHITECTURE already state as
    the intent. The builder composed it the other way round (`RetryLlm` outside,
    `builder.ts:1262-1270`), so every attempt counted; harmless while the
    breaker lived only on the startup agent, but with a shared breaker two
    throttled requests would open a key for every session. The builder puts its
    retry inside the breaker in both modes: its own breaker
    (`withCircuitBreaker(config)`), and a main LLM that already is a
    `CircuitBreakerLlm` (the server's) — then the retry goes under that wrapper
    with the same breaker (`CircuitBreakerLlm` exposes `inner` read-only,
    additive). Role LLMs keep no retry, as today.
- **YAML `mcp:` auto-connect stays gated** (one connection, made at startup).
  After this change `applyServerExtras` guards only this, and its doc says so.

### 14.3 History

One shared store, read per session. `buildSessionAgent` passes the server's
`historyRag` (the strategy-wrapped global store) to every session agent:

- Reads already filter by session. The `rag-history` stage queries with
  `scope: 'session'`, which sets `ragFilter.sessionId`
  (`pipeline/handlers/rag-query.ts:73-93`), and every built-in store implements
  that filter under conformance tests.
- Writes already carry `sessionId` / `userId` metadata.
- With `historyAutoSummarizeLimit`, the builder no longer creates a per-session
  `InMemoryRag`, because a `historyRag` is now given. History then survives
  session eviction and works with qdrant / hana / pg.
- `rag.retrieval.history` now applies to session requests. The doc caveat added
  in Task 24 ("no effect on per-session requests") is removed.
- **Contract note (docs):** a custom `IRag` used as the history store **must**
  honour the `sessionId` filter. Otherwise one session sees another's history.
  INTEGRATION.md and the threat model state this.
- **Answer in the summary:** the tool loop records the final assistant text on
  the pipeline context (a new optional field, additive), and
  `HistoryUpsertHandler` uses it instead of `''`.

### 14.4 Cancellation

- Both HTTP routes create one `AbortController` per request. They abort it when
  the client disconnects before the response finished
  (`res.on('close')` with `!res.writableFinished`), and pass its `signal` in the
  options of `process` / `streamProcess`. A finished response never aborts.
- Signals are combined with `AbortSignal.any` (Node ≥ 22 is required);
  `mergeSignals` is replaced by it, which removes the listener leak.
- An aborted request is logged as cancelled (`request_cancelled`), not as an
  error, and writes nothing to a closed socket.
- **A caller's cancellation never counts against a circuit breaker.** With a
  shared breaker, client disconnects would otherwise open the circuit for every
  session: today `CircuitBreakerLlm` and `CircuitBreakerEmbedder` call
  `recordFailure()` on any error, `ABORTED` included. A call is a
  cancellation when the `options.signal` it received is aborted with a reason
  that is not a timeout (`reason.name !== 'TimeoutError'`). Such a call records
  neither a failure nor a success; this applies to `chat`, `streamChat` (an
  error chunk and a throw) and the embedder. A timeout is a failure of the
  call, and the breaker sees it as before. To make the two distinguishable, the
  agent's `timeoutMs` signal (`createTimeoutSignal`, `agent.ts:250`, which today
  aborts with `new Error('Timeout')`) aborts with a `TimeoutError` reason
  (`AbortSignal.timeout`); `AbortSignal.any` keeps the reason of the signal
  that fired. The error code alone is not used: an `ABORTED` error is also what
  a timeout produces. The half-open state
  permits calls while it lasts (`isCallPermitted`), so a cancelled probe leaves
  the breaker half-open and the next call decides.
- Out of scope: the SAP AI Core embedder ignores the signal; an embed call in
  flight finishes. This is recorded as a known limitation.

### 14.5 Unknown `rag.retrieval` store keys

After `builder.build()` in `_buildInfra`, every `rag.retrieval` key is checked.
A key that is not `tools`, `history`, a collection in the global RAG registry,
or a `user/…` / `session/…` name (those appear at run time) produces a startup
warning through `this.warn` (`config_warning`). The warning names the key and
lists the known stores. It is a warning, not an error, because a collection can
be registered after startup.

### 14.6 Testing

- Wiring: a session agent built through SmartServer applies the plugin output
  validator, the skill manager (skill-select injects; no second vectorization of
  the tools store), the configured LLM-call strategy, and the shared breakers.
  A failing LLM call on a session request moves the breaker that `/health`
  reports, and so does a failing call of a controller role LLM and of a stepper
  role LLM resolved through `ctx.resolveLlm` / `ctx.resolveNamedLlm`. Two
  `llm:` entries have separate breakers; one key resolved by two sessions shares
  one breaker; no LLM is wrapped twice.
- History: two sessions on one shared store; each reads only its own
  summaries; the summary includes the answer; `historyAutoSummarizeLimit` with a
  given store creates no `InMemoryRag`; `rag.retrieval.history` applies on a
  session request.
- Cancellation: a client disconnect mid-request aborts the signal the agent
  received (streaming and non-streaming, both routes); a completed response does
  not abort; `AbortSignal.any` composition with `timeoutMs`; no listener left on
  a long-lived signal.
- Cancellation vs breaker: with `failureThreshold` N, N+1 cancelled calls leave
  the breaker closed, for `chat` and for `streamChat` (an `ABORTED` error chunk
  and a throw after abort) and for the embedder; N real failures still open it;
  an `agent.timeoutMs` expiry still counts as a failure.
- Store keys: a typo key warns once; `tools`, `history`, a registered collection
  and a `session/x` key do not warn.

### 14.7 Out of scope

- Making the query expander work (#323) and client adapters work (#324).
- The SAP AI Core embedder honouring `AbortSignal`.
- The always-empty `ragCollections` plumbing in `_buildInfra` (dead code, no
  behaviour).

### 14.8 Architecture-principle check

1. Built on existing components: the session-scope filter of `IRag`,
   `CircuitBreaker` / `CircuitBreakerLlm` / `FallbackRag`, `AbortSignal.any`. No
   app-local glue; the fixes land in the builder seams that the server consumes.
2. The app is the example: SmartServer's request-serving agents now carry the
   configured wiring.
3. Interfaces: consumers keep depending on `IOutputValidator`, `ISkillManager`,
   `ILlmCallStrategy`, `IRag`.
4. ISP: no interface grows; the new builder seams are separate methods/options.
5. Strategy: no new variation point; existing ones now reach the serving agents.
6. File size: wiring moves inside `buildBaseBuilder`; no new god-method.
7. Additive: `withCircuitBreaker(config)`, `withSkillManager(manager)` and
   `setHistoryRag` keep their behaviour. The change consumers see is that
   configured server features now act on requests, which is the documented
   intent.
