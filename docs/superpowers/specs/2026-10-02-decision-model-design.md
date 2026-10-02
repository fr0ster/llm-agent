# Decision models (`IDecisionModel`) + TypeSafe Jev provider + `DecisionReranker`

Status: design approved in brainstorming 2026-10-02; spec awaiting review.
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
5. Additive only — minor release **30.1.0**.

Non-goals:

- The evaluator cascade (next spec).
- `reranker.type: llm` (the existing `LlmReranker` stays plugin/builder-only).
- Health check / model listing on decision models (a separate small interface
  later, if needed).
- Rerank in the controller pipeline (the reranker exists only on the flat
  `SmartAgent` path; unchanged).

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
