# Decision Models (IDecisionModel + TypeSafe Jev + DecisionReranker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a vendor-neutral `IDecisionModel` contract, a TypeSafe Jev provider package, a `DecisionReranker` that uses it, and YAML wiring so SmartServer's per-session and embedded agents rerank RAG results through it.

**Architecture:** The contract lives in `@mcp-abap-adt/llm-agent` beside `ILlm`/`IEmbedder`. `@mcp-abap-adt/typesafe-decision` implements it over `@typesafe-ai/sdk@0.6.0` (fresh client per call, every option explicit). `@mcp-abap-adt/llm-agent-libs` gets `DecisionReranker` (an `IReranker`) and a usage-logging decorator. `@mcp-abap-adt/llm-agent-server-libs` resolves `decision:`/`reranker:` YAML, builds the reranker once in `_buildInfra()` through a new optional `makeDecisionModel` seam, and wires it outside the `applyServerExtras` gate. The binary supplies the seam.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), Node ≥ 22, `node:test` via `tsx`, Biome, npm workspaces, `tsc -b`.

**Spec:** `docs/superpowers/specs/2026-10-02-decision-model-design.md` — read it alongside this plan; section numbers below (§N) refer to it.

## Global Constraints

- All artifacts in English. Biome: 2 spaces, single quotes, semicolons. Gate = `npx biome check <paths>` (not just format — import sorting).
- ESM only; relative imports end in `.js`.
- No `any`. Interfaces start with `I`.
- New package licence: `LGPL-3.0-only`; ships `LICENSE` + `GPL-3.0.txt` (copy from `packages/deepseek-llm/`).
- Every `@mcp-abap-adt/*` dependency of a library is a **peer** with the single repo-wide range (`^30.0.0` for ours, `^2.1.0` for `interfaces-auth`) — `test/repo/scoped-dependencies.test.ts` enforces it. The binary takes them as regular `dependencies`.
- Third-party: `@typesafe-ai/sdk` `^0.6.0` as a regular dependency of `typesafe-decision` only. It must resolve from the registry in `package-lock.json` (no `"link": true` for it).
- Version stays `30.0.0` in every `package.json` during development; Task 14 bumps to `30.1.0` with `node scripts/bump-version.mjs 30.1.0`.
- *Unset is not sent:* optional config fields absent in YAML stay absent; never fill defaults into config objects; `maxRetries: 0` is a value.
- Secrets never in YAML; credentials come from `credentialRef` → `<REF>_API_KEY`; default ref for decision is `DECISION`.
- `npm run dev` resolves workspace imports to `dist/` — run `npm run build` before any live run.
- **Exit codes are part of every expectation.** A verification command piped into `tail`/`grep` reports the filter's status, not the build's or the test's. Run every gate in a shell with `set -o pipefail` (works in bash and zsh), e.g. `set -o pipefail; npm test --workspace X 2>&1 | tail -15`, and read both the output and the exit status. "Expected: PASS" means exit 0 *and* `# fail 0`; "Expected: FAIL" means a non-zero exit.
- Commit after every task (Conventional Commits, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Never `git stash` mid-run. Before each task: `git branch --show-current` is `feat/decision-model`.

## Review Focus

1. **A consumer override of the reranker wording silently drops the passage** — every `r<i>` question must still carry `results[i].text`. Pinned in Task 6 (`override keeps every passage`).
2. **Jev returns a well-typed but nonsensical number** (`NaN`, `"0.7"`, `1.2`, `-0.1`, missing) — must be `DECISION_ERROR`, never a `RagResult.score`. Pinned in Task 3.
3. **`TYPESAFE_*` environment variables present on the host** silently redirect the key, URL, model or turn on body logging. Pinned in Task 2 (`env sentinels never reach the request`).
4. **The reranker resolved at startup never reaches request-serving agents** (session path, embedded `buildAgent`). Pinned in Task 10 (HTTP session test + embedded test + plugin regression).
5. **`maxRetries: 0` / absent optional fields are lost or defaulted on the way from YAML to the provider.** Pinned in Task 8 (resolver) and Task 11 (binary composition).

---

### Task 1: `IDecisionModel` contract in `@mcp-abap-adt/llm-agent`

**Files:**
- Create: `packages/llm-agent/src/interfaces/decision-model.ts`
- Create: `packages/llm-agent/src/interfaces/__tests__/decision-model.test.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts` (add exports next to line 181 `export type { IReranker } from './reranker.js';`)
- Modify: `packages/llm-agent/src/interfaces/request-logger.ts:1-14` (add `'decision'` to `LlmComponent`)
- Modify: `packages/llm-agent-libs/src/logger/default-request-logger.ts:17-31` (`CATEGORY_MAP` is an exhaustive `Record<LlmComponent, TokenCategory>`; without the entry the libs build breaks)
- Test: `packages/llm-agent-libs/src/logger/__tests__/decision-category.test.ts`

**Interfaces:**
- Produces (exported from `@mcp-abap-adt/llm-agent`): `DecisionEntry`, `NoulQuestion`, `ChoiceQuestion`, `ScoreQuestion`, `DecisionQuestion`, `NoulAnswer`, `ChoiceAnswer`, `ScoreAnswer`, `DecisionAnswer`, `DecisionRequest`, `DecisionResult`, `DecisionErrorCode`, `DecisionError` (class), `IDecisionModel`. `LlmComponent` includes `'decision'`.

- [ ] **Step 1: Write the failing tests**

`packages/llm-agent/src/interfaces/__tests__/decision-model.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DecisionError,
  type IDecisionModel,
  type LlmComponent,
  SmartAgentError,
} from '../../index.js';

describe('DecisionError', () => {
  it('is a SmartAgentError with its own name and the given code', () => {
    const e = new DecisionError('bad', 'DECISION_AUTH');
    assert.ok(e instanceof SmartAgentError);
    assert.equal(e.name, 'DecisionError');
    assert.equal(e.code, 'DECISION_AUTH');
    assert.equal(e.message, 'bad');
  });

  it('defaults to DECISION_ERROR', () => {
    assert.equal(new DecisionError('x').code, 'DECISION_ERROR');
  });
});

describe('IDecisionModel', () => {
  it('is implementable with Result, not throw', async () => {
    const m: IDecisionModel = {
      model: 'fake',
      decide: async () => ({
        ok: true,
        value: {
          model: 'fake-1',
          answers: { q: { type: 'noul', probability: 0.5 } },
        },
      }),
    };
    const r = await m.decide({
      state: 's',
      questions: { q: { type: 'noul' } },
    });
    assert.ok(r.ok);
  });

  it("LlmComponent accepts 'decision'", () => {
    const c: LlmComponent = 'decision';
    assert.equal(c, 'decision');
  });
});
```

`packages/llm-agent-libs/src/logger/__tests__/decision-category.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATEGORY_MAP } from '../default-request-logger.js';

test('decision calls count as auxiliary tokens', () => {
  assert.equal(CATEGORY_MAP.decision, 'auxiliary');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace @mcp-abap-adt/llm-agent 2>&1 | tail -20`
Expected: FAIL — `DecisionError` is not exported.

- [ ] **Step 3: Implement the contract**

`packages/llm-agent/src/interfaces/decision-model.ts`:

```ts
import type { JsonValue } from './tool-loop-context-strategy.js';
import { type CallOptions, type Result, SmartAgentError } from './types.js';

/**
 * What is judged, and how a question or criterion is put: text, a JSON object,
 * or a JSON array.
 */
export type DecisionEntry = string | { [k: string]: JsonValue } | JsonValue[];

/** A yes/no question. */
export interface NoulQuestion {
  type: 'noul';
  instructions?: DecisionEntry;
  criteria?: { true?: DecisionEntry; false?: DecisionEntry };
}

/** Pick one of at least two named labels. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions?: DecisionEntry;
  /** At least two labels; a `null` description leaves the label undescribed. */
  criteria: Record<string, DecisionEntry | null>;
}

/** Place the state on an ordered rubric. */
export interface ScoreQuestion {
  type: 'score';
  instructions?: DecisionEntry;
  /** At least two rubric levels; the index is the score. */
  criteria: readonly (DecisionEntry | null)[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  /** P(yes), finite, in [0, 1]. */
  probability: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  /** One of the question's labels. */
  choice: string;
  /** Finite, in [0, 1]. */
  confidence: number;
  /** Exactly the question's labels; each value finite, in [0, 1]. */
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  /** Expected score, finite, in [0, levels − 1]; may fall between levels. */
  score: number;
  /** Finite, in [0, 1]. */
  confidence: number;
  /** Exactly the keys 0 … levels − 1; each value finite, in [0, 1]. */
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

/**
 * A model that answers typed questions about a state with numbers, not text.
 *
 * - Returns `Result`; never throws for provider failures.
 * - A question type the implementation cannot answer fails the whole request
 *   with `DECISION_UNSUPPORTED_QUESTION`; answers are never dropped or faked.
 * - Cancellation through `options.signal` yields `DECISION_ABORTED`.
 * - On `ok: true` the numeric invariants documented on the answer types hold;
 *   consumers may rely on them without re-checking.
 */
export interface IDecisionModel {
  /** Configured model identifier, for logs. */
  readonly model?: string;
  decide(
    request: DecisionRequest,
    options?: CallOptions,
  ): Promise<Result<DecisionResult, DecisionError>>;
}
```

In `packages/llm-agent/src/interfaces/index.ts`, after line 181:

```ts
export type {
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionAnswer,
  DecisionEntry,
  DecisionErrorCode,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  IDecisionModel,
  NoulAnswer,
  NoulQuestion,
  ScoreAnswer,
  ScoreQuestion,
} from './decision-model.js';
export { DecisionError } from './decision-model.js';
```

In `packages/llm-agent/src/interfaces/request-logger.ts`, add `| 'decision'` as the last member of `LlmComponent` (after `| 'oracle'`).

In `packages/llm-agent-libs/src/logger/default-request-logger.ts`, add to `CATEGORY_MAP` after `oracle: 'auxiliary',`:

```ts
  decision: 'auxiliary',
```

- [ ] **Step 4: Build and run tests**

Run: `npx tsc -b packages/llm-agent packages/llm-agent-libs && npm test --workspace @mcp-abap-adt/llm-agent --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | tail -15`
Expected: PASS, 0 failures.

- [ ] **Step 5: Lint and commit**

```bash
npx biome check packages/llm-agent/src packages/llm-agent-libs/src/logger
git add packages/llm-agent/src packages/llm-agent-libs/src/logger
git commit -m "feat(llm-agent): IDecisionModel contract for decision models

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `@mcp-abap-adt/typesafe-decision` — package, request/response mapping, credential and env isolation

**Files:**
- Create: `packages/typesafe-decision/package.json`, `tsconfig.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `GPL-3.0.txt`
- Create: `packages/typesafe-decision/src/index.ts`
- Create: `packages/typesafe-decision/src/typesafe-decision-model.ts`
- Create: `packages/typesafe-decision/src/__tests__/fake-fetch.ts` (helper, not a test file)
- Create: `packages/typesafe-decision/src/__tests__/typesafe-decision-model.test.ts`
- Create: `packages/typesafe-decision/src/__tests__/credential.test.ts`
- Modify: root `package.json` scripts `build` and `clean` (add `packages/typesafe-decision` right after `packages/llm-agent`)
- Modify: `tsconfig.typecheck.json` `include` (add `"packages/typesafe-decision/src/__tests__/credential.test.ts"` after the `deepseek-llm` credential test line)

**Interfaces:**
- Consumes: Task 1 types from `@mcp-abap-adt/llm-agent`; `IApiKeyCredential` from `@mcp-abap-adt/interfaces-auth`.
- Produces: `TypeSafeDecisionModel implements IDecisionModel`, `TypeSafeDecisionConfig`, `TYPESAFE_DEFAULT_MODEL = 'jev-latest'`, `TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai'`. Internal `mapAnswers(questions, raw): Result<Record<string, DecisionAnswer>, DecisionError>` (Task 3 extends it) and `mapError(err): DecisionError` (Task 4 fills it).

- [ ] **Step 1: Scaffold the package**

`packages/typesafe-decision/package.json`:

```json
{
  "name": "@mcp-abap-adt/typesafe-decision",
  "version": "30.0.0",
  "description": "TypeSafe AI (Jev) decision-model provider (IDecisionModel) for @mcp-abap-adt/llm-agent.",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md", "LICENSE", "GPL-3.0.txt"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "tsc -p tsconfig.json --clean",
    "test": "node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'"
  },
  "license": "LGPL-3.0-only",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/fr0ster/llm-agent.git"
  },
  "publishConfig": { "access": "public" },
  "dependencies": {
    "@typesafe-ai/sdk": "^0.6.0"
  },
  "peerDependencies": {
    "@mcp-abap-adt/interfaces-auth": "^2.1.0",
    "@mcp-abap-adt/llm-agent": "^30.0.0"
  }
}
```

`packages/typesafe-decision/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2022", "DOM"],
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["**/__tests__/**", "**/*.test.ts", "dist"],
  "references": [{ "path": "../llm-agent" }]
}
```

```bash
cp packages/deepseek-llm/LICENSE packages/deepseek-llm/GPL-3.0.txt packages/typesafe-decision/
```

`packages/typesafe-decision/CHANGELOG.md`:

```markdown
# @mcp-abap-adt/typesafe-decision

## Unreleased

- New package: `TypeSafeDecisionModel`, an `IDecisionModel` over TypeSafe AI's Jev.
```

`packages/typesafe-decision/README.md` — the badge lines and the `## License` section copied verbatim from `packages/deepseek-llm/README.md` (title changed), plus:

```markdown
# @mcp-abap-adt/typesafe-decision

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

TypeSafe AI (Jev) decision-model provider for `@mcp-abap-adt/llm-agent`.

Jev is not an LLM: it answers typed questions (`noul` yes/no, `choice`, `score`)
about a state with numbers only. This package implements `IDecisionModel` over
`@typesafe-ai/sdk`.

Exports:
- `TypeSafeDecisionModel` — implements `IDecisionModel`.
- `TypeSafeDecisionConfig` — configuration type.

```ts
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { TypeSafeDecisionModel } from '@mcp-abap-adt/typesafe-decision';

const model = new TypeSafeDecisionModel({
  credential: staticApiKey(process.env.DECISION_API_KEY ?? ''),
});
const r = await model.decide({
  state: 'I was charged twice.',
  questions: { billing: { type: 'noul', instructions: 'Is this about billing?' } },
});
if (r.ok) console.log(r.value.answers.billing);
```

The key is asked from the credential on every call, so a rotating key rotates.
`TYPESAFE_*` environment variables are never read: every client option is
passed explicitly. Data sent: the state and the questions go to TypeSafe's API.

## License
(copied from deepseek-llm/README.md)
```

Root `package.json`: in both `build` and `clean`, insert ` packages/typesafe-decision` right after `packages/llm-agent` (the first entry).

`tsconfig.typecheck.json`: add after the `deepseek-llm` credential test line:

```json
    "packages/typesafe-decision/src/__tests__/credential.test.ts",
```

Install the SDK (registry only):

```bash
npm install
grep -n '"node_modules/@typesafe-ai/sdk"' -A6 package-lock.json
```

Expected: an entry with `"resolved": "https://registry.npmjs.org/@typesafe-ai/sdk/-/sdk-0.6.0.tgz"` and no `"link": true`.

- [ ] **Step 2: Write the fake fetch helper**

`packages/typesafe-decision/src/__tests__/fake-fetch.ts`:

```ts
/** A recorded request and a scripted response, for driving the SDK offline. */
export interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export function fakeFetch(
  respond: (req: Recorded) => { status: number; body: unknown },
) {
  const calls: Recorded[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const rec: Recorded = {
      url: input,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    };
    calls.push(rec);
    const { status, body } = respond(rec);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

/**
 * A fetch that never answers, with real fetch semantics for cancellation: an
 * ALREADY-aborted signal rejects at once (an 'abort' listener would never fire
 * for it — the classic hang), and a later abort rejects when it happens.
 * `entered` resolves once the request is inside fetch.
 */
export function blockingFetch() {
  let markEntered: () => void = () => {};
  const entered = new Promise<void>((r) => {
    markEntered = r;
  });
  const fetch = (_input: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
      markEntered();
    });
  return { fetch, entered };
}

/** A well-formed SystemOne response for the given answers. */
export function okBody(answers: Record<string, unknown>, model = 'jev-1.13.0') {
  return {
    status: 200,
    body: { model, answers, usage: { input_tokens: 12, output_tokens: 3 } },
  };
}
```

- [ ] **Step 3: Write the failing tests**

`packages/typesafe-decision/src/__tests__/typesafe-decision-model.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { TypeSafeDecisionModel } from '../typesafe-decision-model.js';
import { fakeFetch, okBody } from './fake-fetch.js';

describe('TypeSafeDecisionModel — request mapping', () => {
  it('posts state, questions and the model to /v1/systemone', async () => {
    const f = fakeFetch(() =>
      okBody({
        a: { type: 'noul', noul: 0.8 },
        b: {
          type: 'choice',
          choice: 'x',
          confidence: 0.9,
          probabilities: { x: 0.9, y: 0.1 },
        },
        c: {
          type: 'score',
          score: 1.5,
          confidence: 0.7,
          legend: { 0: 'lo', 1: 'mid', 2: 'hi' },
          probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 },
        },
      }),
    );
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    const r = await m.decide({
      state: { text: 'hello' },
      questions: {
        a: { type: 'noul', instructions: 'yes?' },
        b: { type: 'choice', criteria: { x: 'X', y: null } },
        c: { type: 'score', criteria: ['lo', 'mid', 'hi'] },
      },
    });
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.deepEqual(f.calls[0].body.state, { text: 'hello' });
    assert.equal(f.calls[0].body.model, 'jev-latest');
    assert.deepEqual(f.calls[0].body.questions, {
      a: { type: 'noul', instructions: 'yes?' },
      b: { type: 'choice', criteria: { x: 'X', y: null } },
      c: { type: 'score', criteria: ['lo', 'mid', 'hi'] },
    });
  });

  it('uses the configured model and base URL', async () => {
    const f = fakeFetch(() => okBody({ a: { type: 'noul', noul: 0.1 } }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      model: 'jev-1.13.0',
      baseUrl: 'https://proxy.example/typesafe/',
      fetch: f.fetch,
    });
    await m.decide({ state: 's', questions: { a: { type: 'noul' } } });
    assert.equal(f.calls[0].url, 'https://proxy.example/typesafe/v1/systemone');
    assert.equal(f.calls[0].body.model, 'jev-1.13.0');
    assert.equal(m.model, 'jev-1.13.0');
  });
});

describe('TypeSafeDecisionModel — response mapping', () => {
  it('renames noul to probability, drops legend, numeric score keys, camelCase usage', async () => {
    const f = fakeFetch(() =>
      okBody({
        a: { type: 'noul', noul: 0.8 },
        c: {
          type: 'score',
          score: 1.5,
          confidence: 0.7,
          legend: { 0: 'lo', 1: 'mid', 2: 'hi' },
          probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 },
        },
      }),
    );
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    const r = await m.decide({
      state: 's',
      questions: {
        a: { type: 'noul' },
        c: { type: 'score', criteria: ['lo', 'mid', 'hi'] },
      },
    });
    assert.ok(r.ok);
    assert.deepEqual(r.value.answers.a, { type: 'noul', probability: 0.8 });
    assert.deepEqual(r.value.answers.c, {
      type: 'score',
      score: 1.5,
      confidence: 0.7,
      probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 },
    });
    assert.deepEqual(Object.keys(r.value.answers.c), [
      'type',
      'score',
      'confidence',
      'probabilities',
    ]);
    assert.equal(r.value.model, 'jev-1.13.0');
    assert.deepEqual(r.value.usage, { inputTokens: 12, outputTokens: 3 });
  });

  it('a missing answer is DECISION_ERROR, never a partial result', async () => {
    const f = fakeFetch(() => okBody({ a: { type: 'noul', noul: 0.8 } }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    const r = await m.decide({
      state: 's',
      questions: { a: { type: 'noul' }, b: { type: 'noul' } },
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_ERROR');
    assert.match(r.error.message, /'b'/);
  });

  it('an answer of the wrong type is DECISION_ERROR', async () => {
    const f = fakeFetch(() =>
      okBody({
        a: {
          type: 'choice',
          choice: 'x',
          confidence: 1,
          probabilities: { x: 1 },
        },
      }),
    );
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    const r = await m.decide({ state: 's', questions: { a: { type: 'noul' } } });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_ERROR');
  });
});

describe('TypeSafeDecisionModel — unset is not sent', () => {
  it('does not pass timeout or retry when they are unset', async () => {
    // With the SDK default (2 retries), a 500 is attempted 3 times.
    const f = fakeFetch(() => ({ status: 500, body: { error: 'x' } }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    await m.decide({ state: 's', questions: { a: { type: 'noul' } } });
    assert.equal(f.calls.length, 3);
  });

  it('maxRetries: 0 is a value, not "unset"', async () => {
    const f = fakeFetch(() => ({ status: 500, body: { error: 'x' } }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      fetch: f.fetch,
    });
    await m.decide({ state: 's', questions: { a: { type: 'noul' } } });
    assert.equal(f.calls.length, 1);
  });
});
```

Note: the "3 attempts" test waits through the SDK's real backoff (≤ ~1.5 s). Acceptable; do not mock timers inside the SDK.

`packages/typesafe-decision/src/__tests__/credential.test.ts`:

```ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { TypeSafeDecisionModel } from '../typesafe-decision-model.js';
import { fakeFetch, okBody } from './fake-fetch.js';

const ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'TYPESAFE_BASE_URL',
  'TYPESAFE_DEFAULT_MODEL',
  'TYPESAFE_LOG_LEVEL',
] as const;

describe('TypeSafeDecisionModel credential', () => {
  it('presents a freshly asked secret on EVERY call', async () => {
    let n = 0;
    const rotating: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => `sk-ts-${++n}`,
    };
    const f = fakeFetch(() => okBody({ a: { type: 'noul', noul: 0.5 } }));
    const m = new TypeSafeDecisionModel({ credential: rotating, fetch: f.fetch });
    const req = { state: 's', questions: { a: { type: 'noul' as const } } };
    await m.decide(req);
    await m.decide(req);
    assert.deepEqual(
      f.calls.map((c) => c.headers.authorization),
      ['Bearer sk-ts-1', 'Bearer sk-ts-2'],
      'a key resolved once at construction would be identical here',
    );
  });

  describe('environment isolation', () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      process.env.TYPESAFE_API_KEY = 'ENV-KEY-SENTINEL';
      process.env.TYPESAFE_BASE_URL = 'https://env-sentinel.invalid';
      process.env.TYPESAFE_DEFAULT_MODEL = 'env-model-sentinel';
      process.env.TYPESAFE_LOG_LEVEL = 'debug';
    });
    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it('never lets TYPESAFE_* reach the request or turn on logging', async () => {
      const logged: unknown[] = [];
      const origDebug = console.debug;
      const origInfo = console.info;
      console.debug = (...a: unknown[]) => logged.push(a);
      console.info = (...a: unknown[]) => logged.push(a);
      try {
        const f = fakeFetch(() => okBody({ a: { type: 'noul', noul: 0.5 } }));
        const m = new TypeSafeDecisionModel({
          credential: { kind: 'api-key', secret: async () => 'cfg-key' },
          fetch: f.fetch,
        });
        const r = await m.decide({
          state: 's',
          questions: { a: { type: 'noul' } },
        });
        assert.ok(r.ok);
        const call = f.calls[0];
        assert.equal(call.headers.authorization, 'Bearer cfg-key');
        assert.ok(call.url.startsWith('https://api.typesafe.ai/'));
        assert.equal(call.body.model, 'jev-latest');
        assert.equal(logged.length, 0, 'the SDK must not log request bodies');
      } finally {
        console.debug = origDebug;
        console.info = origInfo;
      }
    });
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npm test --workspace @mcp-abap-adt/typesafe-decision 2>&1 | tail -20`
Expected: FAIL — cannot find module `../typesafe-decision-model.js`.

- [ ] **Step 5: Implement**

`packages/typesafe-decision/src/typesafe-decision-model.ts`:

```ts
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import {
  type CallOptions,
  type DecisionAnswer,
  DecisionError,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResult,
  type IDecisionModel,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import {
  type Question,
  type Questions,
  type RequestOptions,
  TypeSafeClient,
  type TypeSafeClientConfig,
} from '@typesafe-ai/sdk';
import { mapAnswers } from './map-answers.js';
import { mapError } from './map-error.js';

export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';
export const TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai';

export interface TypeSafeDecisionConfig {
  /** Asked on every call, so a rotating key rotates. */
  credential: IApiKeyCredential;
  /** Unset → `jev-latest`. */
  model?: string;
  /** Unset → `https://api.typesafe.ai`. */
  baseUrl?: string;
  /** Per-attempt timeout in ms; unset → SDK default. */
  timeoutMs?: number;
  /** Unset → SDK default (2). `0` disables retries. */
  maxRetries?: number;
  /** Test seam; unset → global fetch. */
  fetch?: TypeSafeClientConfig['fetch'];
}

function toSdkQuestions(questions: Record<string, DecisionQuestion>): Questions {
  const out: Questions = {};
  for (const [key, q] of Object.entries(questions)) {
    // Shapes match the SDK's field for field; the score rubric's "at least two"
    // tuple type is enforced by the SDK at run time (TypeSafeError → invalid).
    out[key] = q as unknown as Question;
  }
  return out;
}

/**
 * `IDecisionModel` over TypeSafe AI's Jev. A fresh `TypeSafeClient` per call:
 * the SDK freezes the key at construction and appends its own Authorization
 * header after per-call headers, so a per-call client is the only way to honour
 * a rotating credential. Every option is explicit, so `TYPESAFE_*` environment
 * variables are never consulted.
 */
export class TypeSafeDecisionModel implements IDecisionModel {
  readonly model: string;
  private readonly cfg: TypeSafeDecisionConfig;

  constructor(cfg: TypeSafeDecisionConfig) {
    if (!cfg?.credential) {
      throw new Error('TypeSafeDecisionModel requires a credential');
    }
    this.cfg = cfg;
    this.model = cfg.model ?? TYPESAFE_DEFAULT_MODEL;
  }

  async decide(
    request: DecisionRequest,
    options?: CallOptions,
  ): Promise<Result<DecisionResult, DecisionError>> {
    try {
      const client = new TypeSafeClient({
        apiKey: await this.cfg.credential.secret(),
        baseURL: this.cfg.baseUrl ?? TYPESAFE_DEFAULT_BASE_URL,
        defaultModel: this.model,
        logLevel: 'off',
        ...(this.cfg.timeoutMs !== undefined
          ? { timeout: this.cfg.timeoutMs }
          : {}),
        ...(this.cfg.maxRetries !== undefined
          ? { retry: { maxRetries: this.cfg.maxRetries } }
          : {}),
        ...(this.cfg.fetch !== undefined ? { fetch: this.cfg.fetch } : {}),
      });
      const callOptions: RequestOptions = options?.signal
        ? { signal: options.signal }
        : {};
      const raw = await client.systemOne(
        { state: request.state, questions: toSdkQuestions(request.questions) },
        callOptions,
      );
      const answers = mapAnswers(
        request.questions,
        raw.answers as Record<string, unknown>,
      );
      if (!answers.ok) return answers;
      const value: DecisionResult = {
        answers: answers.value as Record<string, DecisionAnswer>,
        model: raw.model,
      };
      if (raw.usage) {
        value.usage = {
          inputTokens: raw.usage.input_tokens,
          outputTokens: raw.usage.output_tokens,
        };
      }
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: mapError(err) };
    }
  }
}
```

`packages/typesafe-decision/src/map-answers.ts` (Task 3 adds the numeric rules):

```ts
import {
  type DecisionAnswer,
  DecisionError,
  type DecisionQuestion,
  type Result,
} from '@mcp-abap-adt/llm-agent';

type Raw = Record<string, unknown>;

function fail(key: string, rule: string): Result<never, DecisionError> {
  return {
    ok: false,
    error: new DecisionError(`answer '${key}': ${rule}`, 'DECISION_ERROR'),
  };
}

function numericKeys(obj: Raw): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(obj)) out[Number(k)] = v as number;
  return out;
}

/** Map and check one answer per requested key; any violation fails the call. */
export function mapAnswers(
  questions: Record<string, DecisionQuestion>,
  raw: Record<string, unknown> | undefined,
): Result<Record<string, DecisionAnswer>, DecisionError> {
  const out: Record<string, DecisionAnswer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const a = raw?.[key] as Raw | undefined;
    if (!a || typeof a !== 'object') return fail(key, 'missing');
    if (a.type !== q.type) {
      return fail(key, `type '${String(a.type)}' does not match '${q.type}'`);
    }
    switch (q.type) {
      case 'noul':
        out[key] = { type: 'noul', probability: a.noul as number };
        break;
      case 'choice':
        out[key] = {
          type: 'choice',
          choice: a.choice as string,
          confidence: a.confidence as number,
          probabilities: { ...(a.probabilities as Record<string, number>) },
        };
        break;
      case 'score':
        out[key] = {
          type: 'score',
          score: a.score as number,
          confidence: a.confidence as number,
          probabilities: numericKeys((a.probabilities ?? {}) as Raw),
        };
        break;
    }
  }
  return { ok: true, value: out };
}
```

`packages/typesafe-decision/src/map-error.ts` (Task 4 fills in the table):

```ts
import { DecisionError } from '@mcp-abap-adt/llm-agent';

export function mapError(err: unknown): DecisionError {
  return new DecisionError(
    err instanceof Error ? err.message : String(err),
    'DECISION_ERROR',
  );
}
```

`packages/typesafe-decision/src/index.ts`:

```ts
export {
  TYPESAFE_DEFAULT_BASE_URL,
  TYPESAFE_DEFAULT_MODEL,
  type TypeSafeDecisionConfig,
  TypeSafeDecisionModel,
} from './typesafe-decision-model.js';
```

- [ ] **Step 6: Run tests**

Run: `npx tsc -b packages/typesafe-decision && npm test --workspace @mcp-abap-adt/typesafe-decision 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 7: Run repo tests (licensing / peers / badges)**

Run: `node --import tsx/esm --test 'test/repo/*.test.ts' 2>&1 | tail -15`
Expected: PASS — the new package declares `LGPL-3.0-only`, ships both licence texts, has the badges, single peer ranges, version `30.0.0`.

- [ ] **Step 8: Lint and commit**

```bash
npx biome check packages/typesafe-decision package.json tsconfig.typecheck.json
git add packages/typesafe-decision package.json package-lock.json tsconfig.typecheck.json
git commit -m "feat(typesafe-decision): IDecisionModel provider for TypeSafe Jev

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `typesafe-decision` — numeric validation of answers

**Files:**
- Modify: `packages/typesafe-decision/src/map-answers.ts`
- Test: `packages/typesafe-decision/src/__tests__/map-answers.test.ts`

**Interfaces:**
- Consumes: `mapAnswers(questions, raw)` from Task 2.
- Produces: same signature; now enforces spec §5 item 4.

- [ ] **Step 1: Write the failing tests**

`packages/typesafe-decision/src/__tests__/map-answers.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DecisionQuestion } from '@mcp-abap-adt/llm-agent';
import { mapAnswers } from '../map-answers.js';

const noulQ: Record<string, DecisionQuestion> = { a: { type: 'noul' } };
const choiceQ: Record<string, DecisionQuestion> = {
  a: { type: 'choice', criteria: { x: 'X', y: 'Y' } },
};
const scoreQ: Record<string, DecisionQuestion> = {
  a: { type: 'score', criteria: ['lo', 'mid', 'hi'] },
};

function rejects(q: Record<string, DecisionQuestion>, a: unknown, why: string) {
  const r = mapAnswers(q, { a });
  assert.ok(!r.ok, `expected rejection: ${why}`);
  assert.equal(r.error.code, 'DECISION_ERROR');
  assert.match(r.error.message, /'a'/);
}

describe('noul probability', () => {
  for (const [bad, why] of [
    [undefined, 'absent'],
    ['0.7', 'string'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [-0.1, 'negative'],
    [1.2, 'above 1'],
  ] as const) {
    it(`rejects ${why}`, () => rejects(noulQ, { type: 'noul', noul: bad }, why));
  }
  for (const ok of [0, 1, 0.5]) {
    it(`accepts ${ok}`, () => {
      const r = mapAnswers(noulQ, { a: { type: 'noul', noul: ok } });
      assert.ok(r.ok);
      assert.deepEqual(r.value.a, { type: 'noul', probability: ok });
    });
  }
});

describe('choice', () => {
  const good = {
    type: 'choice',
    choice: 'x',
    confidence: 0.8,
    probabilities: { x: 0.8, y: 0.2 },
  };
  it('accepts a well-formed answer', () => {
    assert.ok(mapAnswers(choiceQ, { a: good }).ok);
  });
  it('rejects an unknown label', () =>
    rejects(choiceQ, { ...good, choice: 'z' }, 'unknown label'));
  it('rejects confidence above 1', () =>
    rejects(choiceQ, { ...good, confidence: 1.5 }, 'confidence'));
  it('rejects a missing label in probabilities', () =>
    rejects(choiceQ, { ...good, probabilities: { x: 1 } }, 'label set'));
  it('rejects an extra label in probabilities', () =>
    rejects(
      choiceQ,
      { ...good, probabilities: { x: 0.5, y: 0.3, z: 0.2 } },
      'extra label',
    ));
  it('rejects a non-finite probability', () =>
    rejects(
      choiceQ,
      { ...good, probabilities: { x: Number.NaN, y: 0.2 } },
      'NaN prob',
    ));
});

describe('score', () => {
  const good = {
    type: 'score',
    score: 1.4,
    confidence: 0.6,
    probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 },
  };
  it('accepts a well-formed answer', () => {
    assert.ok(mapAnswers(scoreQ, { a: good }).ok);
  });
  it('accepts the boundaries 0 and levels - 1', () => {
    assert.ok(mapAnswers(scoreQ, { a: { ...good, score: 0 } }).ok);
    assert.ok(mapAnswers(scoreQ, { a: { ...good, score: 2 } }).ok);
  });
  it('rejects a score above levels - 1', () =>
    rejects(scoreQ, { ...good, score: 2.1 }, 'score range'));
  it('rejects a negative score', () =>
    rejects(scoreQ, { ...good, score: -0.5 }, 'negative score'));
  it('rejects a missing level key', () =>
    rejects(scoreQ, { ...good, probabilities: { 0: 0.5, 1: 0.5 } }, 'keys'));
  it('rejects a non-integer level key', () =>
    rejects(
      scoreQ,
      { ...good, probabilities: { 0: 0.1, 1: 0.4, 1.5: 0.5 } },
      'non-integer key',
    ));
  it('rejects a string confidence', () =>
    rejects(scoreQ, { ...good, confidence: '0.6' }, 'string confidence'));
});

it('does not require probabilities to sum to 1', () => {
  const r = mapAnswers(choiceQ, {
    a: {
      type: 'choice',
      choice: 'x',
      confidence: 0.8,
      probabilities: { x: 0.8, y: 0.3 },
    },
  });
  assert.ok(r.ok);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace @mcp-abap-adt/typesafe-decision 2>&1 | grep -E "^# (pass|fail)"`
Expected: failures in `map-answers.test.ts`.

- [ ] **Step 3: Implement the rules**

Replace the `switch` in `packages/typesafe-decision/src/map-answers.ts` and add helpers:

```ts
function unit(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function sameKeys(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const set = new Set(expected);
  return actual.every((k) => set.has(k));
}
```

```ts
    switch (q.type) {
      case 'noul': {
        if (!unit(a.noul)) return fail(key, 'probability must be finite in [0, 1]');
        out[key] = { type: 'noul', probability: a.noul };
        break;
      }
      case 'choice': {
        const labels = Object.keys(q.criteria);
        if (typeof a.choice !== 'string' || !labels.includes(a.choice)) {
          return fail(key, `choice '${String(a.choice)}' is not one of the labels`);
        }
        if (!unit(a.confidence)) return fail(key, 'confidence must be finite in [0, 1]');
        const probs = (a.probabilities ?? {}) as Raw;
        if (typeof probs !== 'object' || !sameKeys(Object.keys(probs), labels)) {
          return fail(key, 'probabilities must cover exactly the labels');
        }
        if (!Object.values(probs).every(unit)) {
          return fail(key, 'every probability must be finite in [0, 1]');
        }
        out[key] = {
          type: 'choice',
          choice: a.choice,
          confidence: a.confidence,
          probabilities: { ...(probs as Record<string, number>) },
        };
        break;
      }
      case 'score': {
        const top = q.criteria.length - 1;
        if (
          typeof a.score !== 'number' ||
          !Number.isFinite(a.score) ||
          a.score < 0 ||
          a.score > top
        ) {
          return fail(key, `score must be finite in [0, ${top}]`);
        }
        if (!unit(a.confidence)) return fail(key, 'confidence must be finite in [0, 1]');
        const probs = (a.probabilities ?? {}) as Raw;
        const levels = q.criteria.map((_, i) => String(i));
        if (typeof probs !== 'object' || !sameKeys(Object.keys(probs), levels)) {
          return fail(key, `probabilities must cover exactly 0 … ${top}`);
        }
        if (!Object.values(probs).every(unit)) {
          return fail(key, 'every probability must be finite in [0, 1]');
        }
        out[key] = {
          type: 'score',
          score: a.score,
          confidence: a.confidence,
          probabilities: numericKeys(probs),
        };
        break;
      }
    }
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace @mcp-abap-adt/typesafe-decision 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Lint and commit**

```bash
npx biome check packages/typesafe-decision
git add packages/typesafe-decision
git commit -m "feat(typesafe-decision): validate numeric invariants of every answer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `typesafe-decision` — error mapping

**Files:**
- Modify: `packages/typesafe-decision/src/map-error.ts`
- Test: `packages/typesafe-decision/src/__tests__/map-error.test.ts`

**Interfaces:**
- Produces: `mapError(err: unknown): DecisionError` implementing the table in spec §5 item 5.

- [ ] **Step 1: Write the failing tests**

`packages/typesafe-decision/src/__tests__/map-error.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { TypeSafeDecisionModel } from '../typesafe-decision-model.js';
import { blockingFetch, fakeFetch } from './fake-fetch.js';

async function codeFor(status: number) {
  const f = fakeFetch(() => ({ status, body: { error: 'nope' } }));
  const m = new TypeSafeDecisionModel({
    credential: staticApiKey('k'),
    maxRetries: 0,
    fetch: f.fetch,
  });
  const r = await m.decide({ state: 's', questions: { a: { type: 'noul' } } });
  assert.ok(!r.ok);
  return r.error;
}

describe('HTTP status → DecisionErrorCode', () => {
  for (const [status, code] of [
    [400, 'DECISION_INVALID_REQUEST'],
    [404, 'DECISION_INVALID_REQUEST'],
    [422, 'DECISION_INVALID_REQUEST'],
    [401, 'DECISION_AUTH'],
    [403, 'DECISION_AUTH'],
    [429, 'DECISION_RATE_LIMITED'],
    [500, 'DECISION_UNAVAILABLE'],
    [503, 'DECISION_UNAVAILABLE'],
    [409, 'DECISION_ERROR'],
  ] as const) {
    it(`${status} → ${code}`, async () => {
      const e = await codeFor(status);
      assert.equal(e.code, code);
      assert.equal(e.name, 'DecisionError');
    });
  }
});

describe('non-HTTP failures', () => {
  it('a connection failure → DECISION_UNAVAILABLE', async () => {
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const r = await m.decide({ state: 's', questions: { a: { type: 'noul' } } });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_UNAVAILABLE');
  });

  it('a timeout → DECISION_UNAVAILABLE', async () => {
    const b = blockingFetch();
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      timeoutMs: 20,
      fetch: b.fetch,
    });
    const r = await m.decide({ state: 's', questions: { a: { type: 'noul' } } });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_UNAVAILABLE');
  });

  it('a signal aborted before the request → DECISION_ABORTED', async () => {
    // decide() awaits credential.secret() first, so the SDK hands fetch an
    // ALREADY-aborted signal; a real fetch rejects at once, and so must the fake.
    const ac = new AbortController();
    ac.abort();
    const b = blockingFetch();
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      fetch: b.fetch,
    });
    const r = await m.decide(
      { state: 's', questions: { a: { type: 'noul' } } },
      { signal: ac.signal },
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_ABORTED');
  });

  it('an abort while the request is in flight → DECISION_ABORTED', async () => {
    const ac = new AbortController();
    const b = blockingFetch();
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      fetch: b.fetch,
    });
    const p = m.decide(
      { state: 's', questions: { a: { type: 'noul' } } },
      { signal: ac.signal },
    );
    await b.entered; // the request is inside fetch now
    ac.abort();
    const r = await p;
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_ABORTED');
  });

  it('an SDK pre-request rejection (empty questions) → DECISION_INVALID_REQUEST', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    const r = await m.decide({ state: 's', questions: {} });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_INVALID_REQUEST');
    assert.equal(f.calls.length, 0, 'rejected before any request');
  });

  it('a score rubric with fewer than two levels → DECISION_INVALID_REQUEST', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    const r = await m.decide({
      state: 's',
      questions: { a: { type: 'score', criteria: ['only'] } },
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_INVALID_REQUEST');
  });
});

describe('messages', () => {
  it('never contain the key or the request body', async () => {
    const f = fakeFetch(() => ({ status: 401, body: { error: 'bad key' } }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('sk-SECRET-123'),
      maxRetries: 0,
      fetch: f.fetch,
    });
    const r = await m.decide({
      state: 'PRIVATE-STATE-TEXT',
      questions: { a: { type: 'noul' } },
    });
    assert.ok(!r.ok);
    assert.doesNotMatch(r.error.message, /sk-SECRET-123/);
    assert.doesNotMatch(r.error.message, /PRIVATE-STATE-TEXT/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace @mcp-abap-adt/typesafe-decision 2>&1 | grep -E "^# (pass|fail)"`
Expected: failures in `map-error.test.ts` (everything maps to `DECISION_ERROR`).

- [ ] **Step 3: Implement**

`packages/typesafe-decision/src/map-error.ts`:

```ts
import { DecisionError, type DecisionErrorCode } from '@mcp-abap-adt/llm-agent';
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeError,
  UnprocessableEntityError,
} from '@typesafe-ai/sdk';

function codeOf(err: unknown): DecisionErrorCode {
  // Order matters: every SDK error extends TypeSafeError, and APITimeoutError
  // extends APIConnectionError.
  if (err instanceof APIUserAbortError) return 'DECISION_ABORTED';
  if (
    err instanceof BadRequestError ||
    err instanceof UnprocessableEntityError ||
    err instanceof NotFoundError
  ) {
    return 'DECISION_INVALID_REQUEST';
  }
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return 'DECISION_AUTH';
  }
  if (err instanceof RateLimitError) return 'DECISION_RATE_LIMITED';
  if (err instanceof InternalServerError || err instanceof APIConnectionError) {
    return 'DECISION_UNAVAILABLE';
  }
  if (err instanceof APIError) return 'DECISION_ERROR';
  // A TypeSafeError that is not an API/connection/abort error is thrown before
  // any request (empty questions, score rubric shorter than two).
  if (err instanceof TypeSafeError) return 'DECISION_INVALID_REQUEST';
  return 'DECISION_ERROR';
}

/** Map anything the SDK throws to a DecisionError. Never echoes key or body. */
export function mapError(err: unknown): DecisionError {
  const code = codeOf(err);
  const status = err instanceof APIError ? ` (HTTP ${err.status})` : '';
  const requestId =
    err instanceof APIError && err.requestId ? ` [request ${err.requestId}]` : '';
  const name = err instanceof Error ? err.name : 'Error';
  return new DecisionError(
    `TypeSafe ${name}${status}${requestId}`,
    code,
  );
}
```

The message carries only the error class, status and request id — never the SDK's own message, which may echo the response body.

- [ ] **Step 4: Run tests**

Run: `npm test --workspace @mcp-abap-adt/typesafe-decision 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

If the caller-abort test reports `DECISION_UNAVAILABLE`, the SDK classified the abort as a timeout: check `index.mjs` `attempt()` ("we check which fired to choose the error class") and pass `options.signal` exactly as Task 2 does; do not change the expectation.

- [ ] **Step 5: Lint and commit**

```bash
npx biome check packages/typesafe-decision
git add packages/typesafe-decision
git commit -m "feat(typesafe-decision): map SDK errors to DecisionError codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `wrapDecisionModel` — usage accounting

**Files:**
- Create: `packages/llm-agent-libs/src/adapters/usage-logging-decision-model.ts`
- Modify: `packages/llm-agent-libs/src/index.ts:19` (export next to `wrapEmbedder`)
- Test: `packages/llm-agent-libs/src/adapters/__tests__/usage-logging-decision-model.test.ts`

**Interfaces:**
- Consumes: `IDecisionModel`, `DecisionRequest`, `IRequestLogger`, `LlmCallEntry`, `CallOptions` from `@mcp-abap-adt/llm-agent`.
- Produces: `wrapDecisionModel(inner: IDecisionModel): IDecisionModel` (idempotent).

- [ ] **Step 1: Write the failing test**

Check first: `ls packages/llm-agent-libs/src/adapters/__tests__ 2>/dev/null || echo none` — create the directory if it does not exist.

`packages/llm-agent-libs/src/adapters/__tests__/usage-logging-decision-model.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DecisionError,
  type IDecisionModel,
  type IRequestLogger,
  type LlmCallEntry,
} from '@mcp-abap-adt/llm-agent';
import { wrapDecisionModel } from '../usage-logging-decision-model.js';

function recordingLogger() {
  const calls: LlmCallEntry[] = [];
  const logger = {
    logLlmCall: (e: LlmCallEntry) => calls.push(e),
  } as unknown as IRequestLogger;
  return { calls, logger };
}

const req = { state: 'abcd', questions: { a: { type: 'noul' as const } } };

function model(withUsage: boolean): IDecisionModel {
  return {
    model: 'cfg',
    decide: async () => ({
      ok: true,
      value: {
        model: 'jev-1.13.0',
        answers: { a: { type: 'noul', probability: 0.5 } },
        ...(withUsage ? { usage: { inputTokens: 10, outputTokens: 2 } } : {}),
      },
    }),
  };
}

describe('wrapDecisionModel', () => {
  it('logs one decision entry with measured usage', async () => {
    const { calls, logger } = recordingLogger();
    const r = await wrapDecisionModel(model(true)).decide(req, {
      requestLogger: logger,
      trace: { traceId: 't-1' },
    } as never);
    assert.ok(r.ok);
    assert.equal(calls.length, 1);
    const e = calls[0];
    assert.equal(e.component, 'decision');
    assert.equal(e.model, 'jev-1.13.0');
    assert.equal(e.promptTokens, 10);
    assert.equal(e.completionTokens, 2);
    assert.equal(e.totalTokens, 12);
    assert.equal(e.scope, 'request');
    assert.equal(e.requestId, 't-1');
    assert.equal(e.estimated, undefined);
    assert.ok(e.durationMs >= 0);
  });

  it('estimates when usage is absent', async () => {
    const { calls, logger } = recordingLogger();
    await wrapDecisionModel(model(false)).decide(req, {
      requestLogger: logger,
    } as never);
    assert.equal(calls[0].estimated, true);
    assert.equal(calls[0].completionTokens, 0);
    assert.equal(
      calls[0].promptTokens,
      Math.ceil(JSON.stringify(req).length / 4),
    );
  });

  it('is a no-op without a request logger', async () => {
    const r = await wrapDecisionModel(model(true)).decide(req);
    assert.ok(r.ok);
  });

  it('logs nothing on failure', async () => {
    const { calls, logger } = recordingLogger();
    const failing: IDecisionModel = {
      decide: async () => ({ ok: false, error: new DecisionError('x') }),
    };
    await wrapDecisionModel(failing).decide(req, {
      requestLogger: logger,
    } as never);
    assert.equal(calls.length, 0);
  });

  it('is idempotent and keeps the configured model id', () => {
    const once = wrapDecisionModel(model(true));
    assert.equal(wrapDecisionModel(once), once);
    assert.equal(once.model, 'cfg');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -E "usage-logging-decision|^# fail"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/llm-agent-libs/src/adapters/usage-logging-decision-model.ts`:

```ts
import type {
  CallOptions,
  DecisionError,
  DecisionRequest,
  DecisionResult,
  IDecisionModel,
  Result,
} from '@mcp-abap-adt/llm-agent';

const BRAND = Symbol.for('@mcp-abap-adt/usage-logging-decision-model');

class UsageLoggingDecisionModel implements IDecisionModel {
  readonly [BRAND] = true;
  constructor(private readonly inner: IDecisionModel) {}

  get model(): string | undefined {
    return this.inner.model;
  }

  async decide(
    request: DecisionRequest,
    options?: CallOptions,
  ): Promise<Result<DecisionResult, DecisionError>> {
    const started = Date.now();
    const r = await this.inner.decide(request, options);
    const logger = options?.requestLogger;
    if (!r.ok || !logger) return r;
    const usage = r.value.usage;
    const promptTokens =
      usage?.inputTokens ?? Math.ceil(JSON.stringify(request).length / 4);
    const completionTokens = usage?.outputTokens ?? 0;
    logger.logLlmCall({
      component: 'decision',
      model: r.value.model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      durationMs: Date.now() - started,
      scope: 'request',
      requestId: options?.trace?.traceId,
      ...(usage === undefined ? { estimated: true } : {}),
    });
    return r;
  }
}

/**
 * Account every successful decision call to the request's logger
 * (`component: 'decision'`). No logger → no-op. Idempotent.
 */
export function wrapDecisionModel(inner: IDecisionModel): IDecisionModel {
  if ((inner as { [BRAND]?: boolean })[BRAND]) return inner;
  return new UsageLoggingDecisionModel(inner);
}
```

In `packages/llm-agent-libs/src/index.ts`, after the `wrapEmbedder` export:

```ts
export { wrapDecisionModel } from './adapters/usage-logging-decision-model.js';
```

- [ ] **Step 4: Run tests**

Run: `npx tsc -b packages/llm-agent-libs && npm test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Lint and commit**

```bash
npx biome check packages/llm-agent-libs/src
git add packages/llm-agent-libs/src
git commit -m "feat(libs): wrapDecisionModel accounts decision calls per request

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `DecisionReranker`

**Files:**
- Create: `packages/llm-agent-libs/src/reranker/decision-reranker.ts`
- Modify: `packages/llm-agent-libs/src/reranker/index.ts`, `packages/llm-agent-libs/src/index.ts:180-183`
- Test: `packages/llm-agent-libs/src/reranker/__tests__/decision-reranker.test.ts`

**Interfaces:**
- Consumes: `IDecisionModel`, `DecisionEntry`, `RagResult`, `RagError`, `CallOptions`, `Result`, `IReranker`.
- Produces: `DecisionReranker implements IReranker`; `DecisionRerankerOptions { task?: DecisionEntry; criteria?: { true?: DecisionEntry; false?: DecisionEntry } }`; exported constants `DECISION_RERANK_DEFAULT_TASK`, `DECISION_RERANK_DEFAULT_CRITERIA`.

- [ ] **Step 1: Write the failing tests**

`packages/llm-agent-libs/src/reranker/__tests__/decision-reranker.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DecisionError,
  type DecisionRequest,
  type IDecisionModel,
  type RagResult,
} from '@mcp-abap-adt/llm-agent';
import {
  DECISION_RERANK_DEFAULT_CRITERIA,
  DECISION_RERANK_DEFAULT_TASK,
  DecisionReranker,
} from '../decision-reranker.js';

const results: RagResult[] = [
  { text: 'alpha', metadata: { id: 'a' }, score: 0.9 },
  { text: 'beta', metadata: { id: 'b' }, score: 0.8 },
  { text: 'gamma', metadata: { id: 'c' }, score: 0.7 },
];

function fakeModel(probs: number[]) {
  const seen: DecisionRequest[] = [];
  const model: IDecisionModel = {
    decide: async (req) => {
      seen.push(req);
      const answers: Record<string, { type: 'noul'; probability: number }> = {};
      probs.forEach((p, i) => {
        answers[`r${i}`] = { type: 'noul', probability: p };
      });
      return { ok: true, value: { model: 'fake', answers } };
    },
  };
  return { model, seen };
}

describe('DecisionReranker', () => {
  it('empty input → unchanged, no call', async () => {
    const { model, seen } = fakeModel([]);
    const r = await new DecisionReranker(model).rerank('q', []);
    assert.ok(r.ok);
    assert.deepEqual(r.value, []);
    assert.equal(seen.length, 0);
  });

  it('one call: query as state, one noul question per passage', async () => {
    const { model, seen } = fakeModel([0.1, 0.2, 0.3]);
    await new DecisionReranker(model).rerank('the query', results);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].state, 'the query');
    assert.deepEqual(Object.keys(seen[0].questions), ['r0', 'r1', 'r2']);
    assert.deepEqual(seen[0].questions.r1, {
      type: 'noul',
      instructions: { task: DECISION_RERANK_DEFAULT_TASK, passage: 'beta' },
      criteria: DECISION_RERANK_DEFAULT_CRITERIA,
    });
  });

  it('scores = probability, sorted descending, text/metadata untouched', async () => {
    const { model } = fakeModel([0.2, 0.9, 0.5]);
    const r = await new DecisionReranker(model).rerank('q', results);
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((x) => [x.text, x.score, x.metadata.id]),
      [
        ['beta', 0.9, 'b'],
        ['gamma', 0.5, 'c'],
        ['alpha', 0.2, 'a'],
      ],
    );
  });

  it('ties keep the original order (stable)', async () => {
    const { model } = fakeModel([0.5, 0.5, 0.5]);
    const r = await new DecisionReranker(model).rerank('q', results);
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((x) => x.text),
      ['alpha', 'beta', 'gamma'],
    );
  });

  it('a task override keeps every passage', async () => {
    const { model, seen } = fakeModel([0.1, 0.2, 0.3]);
    await new DecisionReranker(model, { task: 'Custom task' }).rerank(
      'q',
      results,
    );
    results.forEach((res, i) => {
      assert.deepEqual(seen[0].questions[`r${i}`], {
        type: 'noul',
        instructions: { task: 'Custom task', passage: res.text },
        criteria: DECISION_RERANK_DEFAULT_CRITERIA,
      });
    });
  });

  it('a criteria override replaces only the criteria', async () => {
    const { model, seen } = fakeModel([0.1, 0.2, 0.3]);
    const criteria = { true: 'relevant', false: 'irrelevant' };
    await new DecisionReranker(model, { criteria }).rerank('q', results);
    const q = seen[0].questions.r0;
    assert.equal(q.type, 'noul');
    if (q.type === 'noul') {
      assert.deepEqual(q.criteria, criteria);
      assert.deepEqual(q.instructions, {
        task: DECISION_RERANK_DEFAULT_TASK,
        passage: 'alpha',
      });
    }
  });

  it('a model error → RERANK_ERROR carrying the decision code', async () => {
    const model: IDecisionModel = {
      decide: async () => ({
        ok: false,
        error: new DecisionError('stale key', 'DECISION_AUTH'),
      }),
    };
    const r = await new DecisionReranker(model).rerank('q', results);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RERANK_ERROR');
    assert.match(r.error.message, /DECISION_AUTH/);
  });

  it('a missing answer → RERANK_ERROR', async () => {
    const { model } = fakeModel([0.1, 0.2]); // r2 missing
    const r = await new DecisionReranker(model).rerank('q', results);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RERANK_ERROR');
  });

  it('passes call options through', async () => {
    let got: unknown;
    const model: IDecisionModel = {
      decide: async (_req, opts) => {
        got = opts;
        return {
          ok: true,
          value: {
            model: 'f',
            answers: { r0: { type: 'noul', probability: 1 } },
          },
        };
      },
    };
    const opts = { sessionId: 's-1' };
    await new DecisionReranker(model).rerank('q', [results[0]], opts);
    assert.equal(got, opts);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -E "decision-reranker|^# fail"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/llm-agent-libs/src/reranker/decision-reranker.ts`:

```ts
import {
  type CallOptions,
  type DecisionEntry,
  type IDecisionModel,
  type NoulQuestion,
  RagError,
  type RagResult,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import type { IReranker } from './types.js';

export const DECISION_RERANK_DEFAULT_TASK =
  'Judge whether this passage helps answer the query given as the state.';

export const DECISION_RERANK_DEFAULT_CRITERIA: {
  true: DecisionEntry;
  false: DecisionEntry;
} = {
  true: 'The passage contains information that helps answer the query.',
  false: 'The passage does not help answer the query.',
};

export interface DecisionRerankerOptions {
  /** Override the default task wording. The passage is always sent alongside
   *  it — this never replaces the passage. */
  task?: DecisionEntry;
  criteria?: { true?: DecisionEntry; false?: DecisionEntry };
}

/**
 * Rerank RAG results with a decision model: one call per store, the query as
 * the state, one yes/no question per passage. `score` becomes P(relevant).
 */
export class DecisionReranker implements IReranker {
  constructor(
    private readonly model: IDecisionModel,
    private readonly options: DecisionRerankerOptions = {},
  ) {}

  async rerank(
    query: string,
    results: RagResult[],
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (results.length === 0) return { ok: true, value: results };

    const task = this.options.task ?? DECISION_RERANK_DEFAULT_TASK;
    const criteria = this.options.criteria ?? DECISION_RERANK_DEFAULT_CRITERIA;
    const questions: Record<string, NoulQuestion> = {};
    results.forEach((r, i) => {
      questions[`r${i}`] = {
        type: 'noul',
        instructions: { task, passage: r.text },
        criteria,
      };
    });

    const res = await this.model.decide({ state: query, questions }, options);
    if (!res.ok) {
      return {
        ok: false,
        error: new RagError(
          `decision rerank failed: ${res.error.code}: ${res.error.message}`,
          'RERANK_ERROR',
        ),
      };
    }

    const scored: Array<{ r: RagResult; i: number }> = [];
    for (let i = 0; i < results.length; i++) {
      const a = res.value.answers[`r${i}`];
      if (!a || a.type !== 'noul') {
        return {
          ok: false,
          error: new RagError(
            `decision rerank: no yes/no answer for passage r${i}`,
            'RERANK_ERROR',
          ),
        };
      }
      scored.push({ r: { ...results[i], score: a.probability }, i });
    }
    scored.sort((x, y) => y.r.score - x.r.score || x.i - y.i);
    return { ok: true, value: scored.map((s) => s.r) };
  }
}
```

`packages/llm-agent-libs/src/reranker/index.ts` — add:

```ts
export {
  DECISION_RERANK_DEFAULT_CRITERIA,
  DECISION_RERANK_DEFAULT_TASK,
  DecisionReranker,
  type DecisionRerankerOptions,
} from './decision-reranker.js';
```

`packages/llm-agent-libs/src/index.ts` — in the `// Reranker` block (lines 180–183) add:

```ts
export {
  DECISION_RERANK_DEFAULT_CRITERIA,
  DECISION_RERANK_DEFAULT_TASK,
  DecisionReranker,
  type DecisionRerankerOptions,
} from './reranker/decision-reranker.js';
```

- [ ] **Step 4: Run tests**

Run: `npx tsc -b packages/llm-agent-libs && npm test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Lint and commit**

```bash
npx biome check packages/llm-agent-libs/src
git add packages/llm-agent-libs/src
git commit -m "feat(libs): DecisionReranker reranks RAG results with a decision model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `RerankHandler` — record failures

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/rerank.ts:23-35`
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/rerank-failure.test.ts`

**Interfaces:**
- Consumes: `PipelineContext` (`ragText`, `ragResults`, `reranker`, `options`), `ISpan.setAttribute(key, string|number|boolean)`.
- Produces: on `!rr.ok` — span attribute `<store>.rerank_error` = error code; `options.sessionLogger.logStep('rerank_error', { store, code, message })`; results unchanged.

- [ ] **Step 1: Write the failing test**

`packages/llm-agent-libs/src/pipeline/handlers/__tests__/rerank-failure.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RagError, type RagResult } from '@mcp-abap-adt/llm-agent';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { RerankHandler } from '../rerank.js';

const results: RagResult[] = [{ text: 't', metadata: {}, score: 0.4 }];

function span() {
  const attrs: Record<string, unknown> = {};
  const s = {
    name: 'rerank',
    setAttribute: (k: string, v: unknown) => {
      attrs[k] = v;
    },
    addEvent() {},
    setStatus() {},
    end() {},
  } as unknown as ISpan;
  return { s, attrs };
}

describe('RerankHandler failure telemetry', () => {
  it('falls back to the original order and records the failure', async () => {
    const steps: Array<[string, unknown]> = [];
    const ctx = {
      ragText: 'q',
      ragResults: { docs: [...results] },
      reranker: {
        rerank: async () => ({
          ok: false,
          error: new RagError('decision rerank failed: DECISION_AUTH', 'RERANK_ERROR'),
        }),
      },
      options: {
        sessionLogger: { logStep: (n: string, d: unknown) => steps.push([n, d]) },
      },
    } as unknown as PipelineContext;
    const { s, attrs } = span();
    await new RerankHandler().execute(ctx, {}, s);
    assert.deepEqual(ctx.ragResults.docs, results);
    assert.equal(attrs['docs.rerank_error'], 'RERANK_ERROR');
    assert.equal(steps.length, 1);
    assert.equal(steps[0][0], 'rerank_error');
    assert.deepEqual(steps[0][1], {
      store: 'docs',
      code: 'RERANK_ERROR',
      message: 'decision rerank failed: DECISION_AUTH',
    });
  });

  it('records nothing on success', async () => {
    const ctx = {
      ragText: 'q',
      ragResults: { docs: [...results] },
      reranker: { rerank: async () => ({ ok: true, value: results }) },
      options: undefined,
    } as unknown as PipelineContext;
    const { s, attrs } = span();
    await new RerankHandler().execute(ctx, {}, s);
    assert.equal(attrs['docs.rerank_error'], undefined);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -E "rerank-failure|^# fail"`
Expected: FAIL — attribute undefined.

- [ ] **Step 3: Implement**

In `packages/llm-agent-libs/src/pipeline/handlers/rerank.ts`, replace the `map` body:

```ts
      entries.map(async ([name, results]) => {
        if (results.length > 0) {
          const rr = await ctx.reranker.rerank(
            ctx.ragText,
            results,
            ctx.options,
          );
          if (!rr.ok) {
            // Behaviour unchanged (original order), but no longer silent: a
            // reranker that always fails (e.g. a stale key) must be visible.
            span.setAttribute(`${name}.rerank_error`, rr.error.code);
            ctx.options?.sessionLogger?.logStep('rerank_error', {
              store: name,
              code: rr.error.code,
              message: rr.error.message,
            });
          }
          return { name, results: rr.ok ? rr.value : results };
        }
        return { name, results };
      }),
```

Also update the file's header comment: "Falls back to original results if reranking fails for a store, recording `<store>.rerank_error` on the span and a `rerank_error` session step."

- [ ] **Step 4: Run tests**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Lint and commit**

```bash
npx biome check packages/llm-agent-libs/src/pipeline
git add packages/llm-agent-libs/src/pipeline
git commit -m "feat(libs): RerankHandler records reranker failures instead of hiding them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: SmartServer config — types, YAML resolution, validation

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/decision-config.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts:239-…` (`SmartServerConfig` gains `decision?`, `reranker?`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/resolve-config-sections.ts` (two resolvers)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/config.ts:240-282` (spread them into `resolved`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/config-validator.ts` (extract `checkNoSecret`; new checks)
- Modify: `packages/llm-agent-server-libs/src/index.ts` (`export * from './smart-agent/decision-config.js';` next to line 17)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/decision-config.test.ts`

**Interfaces:**
- Produces: `SmartServerDecisionConfig { provider: 'typesafe'; model?; credentialRef?; baseUrl?; timeoutMs?; maxRetries? }`, `SmartServerRerankerConfig { type: 'decision' }`, `resolveDecisionSection(yaml): SmartServerDecisionConfig | undefined`, `resolveRerankerSection(yaml): SmartServerRerankerConfig | undefined`.

- [ ] **Step 1: Write the failing tests**

`packages/llm-agent-server-libs/src/smart-agent/__tests__/decision-config.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { resolveSmartServerConfig } from '../config.js';
import { loadYamlConfig } from '../yaml-loader.js';

const LLM = 'llm:\n  provider: openai\n  model: gpt-4o\n';

function resolve(text: string) {
  return resolveSmartServerConfig({}, parse(LLM + text), {}, {
    skipProviderRuntimeChecks: true,
  });
}

describe('decision: / reranker: resolution', () => {
  it('absent sections stay absent', () => {
    const cfg = resolve('');
    assert.equal('decision' in cfg, false);
    assert.equal('reranker' in cfg, false);
  });

  it('copies named fields only; absent optionals stay absent', () => {
    const cfg = resolve('decision:\n  provider: typesafe\n');
    assert.deepEqual(cfg.decision, { provider: 'typesafe' });
    assert.deepEqual(Object.keys(cfg.decision ?? {}), ['provider']);
  });

  it('keeps every field, and maxRetries: 0 stays 0', () => {
    const cfg = resolve(
      [
        'decision:',
        '  provider: typesafe',
        '  model: jev-latest',
        '  credentialRef: TYPESAFE',
        '  baseUrl: https://proxy.example',
        '  timeoutMs: 5000',
        '  maxRetries: 0',
        'reranker:',
        '  type: decision',
        '',
      ].join('\n'),
    );
    assert.deepEqual(cfg.decision, {
      provider: 'typesafe',
      model: 'jev-latest',
      credentialRef: 'TYPESAFE',
      baseUrl: 'https://proxy.example',
      timeoutMs: 5000,
      maxRetries: 0,
    });
    assert.deepEqual(cfg.reranker, { type: 'decision' });
  });

  it('a decision: section without reranker: is valid', () => {
    assert.doesNotThrow(() => resolve('decision:\n  provider: typesafe\n'));
  });
});

describe('${VAR}-substituted numbers (loadYamlConfig substitutes strings)', () => {
  function fromFile(text: string, env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'decision-cfg-'));
    const path = join(dir, 'smart-server.yaml');
    writeFileSync(path, LLM + text);
    try {
      return resolveSmartServerConfig({}, loadYamlConfig(path, env), env, {
        skipProviderRuntimeChecks: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const SECTION =
    'decision:\n  provider: typesafe\n  timeoutMs: ${DT}\n  maxRetries: ${DR}\n';

  it('"5000" and "0" are accepted and become numbers', () => {
    const cfg = fromFile(SECTION, { DT: '5000', DR: '0' });
    assert.equal(cfg.decision?.timeoutMs, 5000);
    assert.equal(cfg.decision?.maxRetries, 0);
  });

  it('an unset variable (empty string) is refused, never read as 0', () => {
    assert.throws(() => fromFile(SECTION, { DT: '5000' }), /decision\.maxRetries/);
  });

  it('a non-numeric value is refused', () => {
    assert.throws(
      () => fromFile(SECTION, { DT: 'soon', DR: '1' }),
      /decision\.timeoutMs/,
    );
  });
});

describe('decision: / reranker: validation', () => {
  for (const [yaml, re] of [
    ['decision:\n  model: x\n', /decision\.provider/],
    ['decision:\n  provider: openai\n', /decision\.provider/],
    ['decision:\n  provider: typesafe\n  credentialRef: ""\n', /decision\.credentialRef/],
    ['decision:\n  provider: typesafe\n  apiKey: sk-x\n', /decision\.apiKey: secrets are no longer read/],
    ['decision:\n  provider: typesafe\n  timeoutMs: 0\n', /decision\.timeoutMs/],
    ['decision:\n  provider: typesafe\n  timeoutMs: 1.5\n', /decision\.timeoutMs/],
    ['decision:\n  provider: typesafe\n  maxRetries: -1\n', /decision\.maxRetries/],
    ['decision:\n  provider: typesafe\nreranker:\n  type: llm\n', /reranker\.type/],
    ['reranker:\n  type: decision\n', /reranker\.type: decision requires a decision: section/],
  ] as const) {
    it(`rejects ${JSON.stringify(yaml)}`, () => {
      assert.throws(() => resolve(yaml), re);
    });
  }

  it('the apiKey refused in decision: is not copied into the config', () => {
    assert.throws(() =>
      resolve('decision:\n  provider: typesafe\n  apiKey: sk-x\n'),
    );
  });

  it('llm.apiKey still produces the same message (extraction kept behaviour)', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          parse('llm:\n  provider: openai\n  model: m\n  apiKey: sk\n'),
          {},
          { skipProviderRuntimeChecks: true },
        ),
      /llm\.apiKey: secrets are no longer read from configuration/,
    );
  });
});
```

Confirm `yaml` is importable in this package's tests: `grep -n '"yaml"' packages/llm-agent-server-libs/package.json` (it is a dependency, `^2.9.1`).

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -E "decision-config|^# fail"`
Expected: FAIL — `cfg.decision` undefined / no validation issue.

- [ ] **Step 3: Implement the types**

`packages/llm-agent-server-libs/src/smart-agent/decision-config.ts`:

```ts
/** `decision:` — a decision model (numbers, not text). Secrets never here. */
export interface SmartServerDecisionConfig {
  provider: 'typesafe';
  model?: string;
  /** Names the account; the composition root resolves it (default `DECISION`). */
  credentialRef?: string;
  baseUrl?: string;
  /** Per-attempt timeout in ms (positive integer). */
  timeoutMs?: number;
  /** Retries after the first attempt (non-negative integer); `0` disables them. */
  maxRetries?: number;
}

/** `reranker:` — which reranker the server wires into its agents. */
export interface SmartServerRerankerConfig {
  /** `decision` uses the model of the `decision:` section. */
  type: 'decision';
}

/**
 * The one normalisation of an integer field, shared by the resolver and the
 * validator. `loadYamlConfig` substitutes `${VAR}` as a STRING, so `"5000"` and
 * `"0"` arrive as text and must count as integers; `""` (an unset variable with
 * no fallback) is invalid, never 0.
 */
export function parseIntegerField(
  value: unknown,
): number | 'invalid' | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : 'invalid';
  }
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) {
    return Number(value);
  }
  return 'invalid';
}
```

In `smart-server.ts`, import the two types and add to `SmartServerConfig` (after `rag?:`):

```ts
  /** Decision model (`decision:`); built only when a consumer (the reranker) asks. */
  decision?: SmartServerDecisionConfig;
  /** Reranker selection (`reranker:`). Conflicts with a plugin reranker. */
  reranker?: SmartServerRerankerConfig;
```

In `packages/llm-agent-server-libs/src/index.ts`, after line 17:

```ts
export * from './smart-agent/decision-config.js';
```

- [ ] **Step 4: Implement the resolvers**

Append to `resolve-config-sections.ts` (import the two types and `parseIntegerField` from `./decision-config.js`):

```ts
/**
 * `decision:` → named fields only. An optional field absent in YAML is absent in
 * the result (unset is not sent); a present falsy value (`maxRetries: 0`) is
 * kept. `apiKey` is never copied — the validator refuses it from the raw YAML.
 */
export function resolveDecisionSection(
  yaml: YamlConfig,
): SmartServerDecisionConfig | undefined {
  const raw = get(yaml, 'decision') as Record<string, unknown> | undefined;
  if (raw === undefined || raw === null) return undefined;
  const out = { provider: raw.provider } as SmartServerDecisionConfig;
  if (raw.model !== undefined) out.model = String(raw.model);
  if (raw.credentialRef !== undefined) {
    out.credentialRef = raw.credentialRef as string;
  }
  if (raw.baseUrl !== undefined) out.baseUrl = String(raw.baseUrl);
  // Invalid values are left out here; the validator (same parser) reports them.
  const timeoutMs = parseIntegerField(raw.timeoutMs);
  if (typeof timeoutMs === 'number') out.timeoutMs = timeoutMs;
  const maxRetries = parseIntegerField(raw.maxRetries);
  if (typeof maxRetries === 'number') out.maxRetries = maxRetries;
  return out;
}

/** `reranker:` → `{ type }`, or undefined when absent. */
export function resolveRerankerSection(
  yaml: YamlConfig,
): SmartServerRerankerConfig | undefined {
  const raw = get(yaml, 'reranker') as Record<string, unknown> | undefined;
  if (raw === undefined || raw === null) return undefined;
  return { type: raw.type } as SmartServerRerankerConfig;
}
```

In `config.ts`, import both and add inside the `resolved` literal, after the `skillPlugins` spread:

```ts
    ...(() => {
      const decision = resolveDecisionSection(yaml);
      return decision ? { decision } : {};
    })(),
    ...(() => {
      const reranker = resolveRerankerSection(yaml);
      return reranker ? { reranker } : {};
    })(),
```

- [ ] **Step 5: Implement validation**

In `config-validator.ts`, extract the inline secret check from `checkLlmRole` (lines ~58-62) into:

```ts
/** A secret arriving from the file is refused, not ignored (§4.6.3). */
function checkNoSecret(
  label: string,
  section: Record<string, unknown> | undefined,
  issues: string[],
): void {
  if (section?.apiKey !== undefined) {
    issues.push(
      `${label}.apiKey: secrets are no longer read from configuration — remove it and, if this role needs an account other than the default, name it with ${label}.credentialRef (your composition root resolves the name).`,
    );
  }
}
```

and call `checkNoSecret(label, role, issues);` in `checkLlmRole` where the inline block was (keep the comment above it). Then add:

```ts
function checkDecision(yaml: YamlConfig, issues: string[]): void {
  const d = get(yaml, 'decision') as Record<string, unknown> | undefined;
  const r = get(yaml, 'reranker') as Record<string, unknown> | undefined;
  if (d !== undefined && d !== null) {
    checkNoSecret('decision', d, issues);
    checkCredentialRef('decision', d.credentialRef, issues);
    if (d.provider !== 'typesafe') {
      issues.push(
        `decision.provider: must be 'typesafe' (got ${JSON.stringify(d.provider)})`,
      );
    }
    const timeoutMs = parseIntegerField(d.timeoutMs);
    if (timeoutMs === 'invalid' || (timeoutMs !== undefined && timeoutMs <= 0)) {
      issues.push('decision.timeoutMs: must be a positive integer (milliseconds)');
    }
    const maxRetries = parseIntegerField(d.maxRetries);
    if (maxRetries === 'invalid' || (maxRetries !== undefined && maxRetries < 0)) {
      issues.push('decision.maxRetries: must be a non-negative integer');
    }
  }
  if (r !== undefined && r !== null) {
    if (r.type !== 'decision') {
      issues.push(
        `reranker.type: must be 'decision' (got ${JSON.stringify(r.type)})`,
      );
    } else if (d === undefined || d === null) {
      issues.push('reranker.type: decision requires a decision: section');
    }
  }
}
```

(import `parseIntegerField` from `./decision-config.js`.) Call `checkDecision(yaml, issues);` in `validateResolvedConfig` right before `if (issues.length > 0) throw …` (line ~471).

- [ ] **Step 6: Run tests**

Run: `npx tsc -b packages/llm-agent-server-libs && npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0` (the whole server-libs suite, so `checkLlmRole` regressions surface).

- [ ] **Step 7: Lint and commit**

```bash
npx biome check packages/llm-agent-server-libs/src
git add packages/llm-agent-server-libs/src
git commit -m "feat(server-libs): decision: and reranker: config sections

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `makeDecisionModel` seam and `resolveReranker`

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/resolve-reranker.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts:342` (`BuildAgentDeps` gains the optional seam), `:978-992` (`_deps` Pick) and `:1022-1036` (constructor copy)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-reranker.test.ts`

**Interfaces:**
- Consumes: `DecisionReranker`, `wrapDecisionModel` (Tasks 5–6); config types (Task 8).
- Produces: `BuildAgentDeps.makeDecisionModel?: (cfg: SmartServerDecisionConfig) => Promise<IDecisionModel>`; `resolveReranker(input: { rerankerCfg?; decisionCfg?; makeDecisionModel?; pluginReranker? }): Promise<IReranker | undefined>`.

- [ ] **Step 1: Write the failing tests**

`packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-reranker.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IDecisionModel, IReranker } from '@mcp-abap-adt/llm-agent';
import { DecisionReranker } from '@mcp-abap-adt/llm-agent-libs';
import { resolveReranker } from '../resolve-reranker.js';

const fakeModel: IDecisionModel = {
  decide: async () => ({
    ok: true,
    value: { model: 'f', answers: { r0: { type: 'noul', probability: 1 } } },
  }),
};
const plugin: IReranker = { rerank: async (_q, r) => ({ ok: true, value: r }) };

describe('resolveReranker', () => {
  it('neither → undefined', async () => {
    assert.equal(await resolveReranker({}), undefined);
  });

  it('only a plugin reranker → it', async () => {
    assert.equal(await resolveReranker({ pluginReranker: plugin }), plugin);
  });

  it('reranker.type: decision → a DecisionReranker over the seam, built once', async () => {
    const seen: unknown[] = [];
    const r = await resolveReranker({
      rerankerCfg: { type: 'decision' },
      decisionCfg: { provider: 'typesafe', model: 'jev-latest' },
      makeDecisionModel: async (cfg) => {
        seen.push(cfg);
        return fakeModel;
      },
    });
    assert.ok(r instanceof DecisionReranker);
    assert.deepEqual(seen, [{ provider: 'typesafe', model: 'jev-latest' }]);
  });

  it('YAML reranker and a plugin reranker → error', async () => {
    await assert.rejects(
      resolveReranker({
        rerankerCfg: { type: 'decision' },
        decisionCfg: { provider: 'typesafe' },
        makeDecisionModel: async () => fakeModel,
        pluginReranker: plugin,
      }),
      /reranker: .* and a plugin reranker/,
    );
  });

  it('decision configured but no seam → error naming the seam', async () => {
    await assert.rejects(
      resolveReranker({
        rerankerCfg: { type: 'decision' },
        decisionCfg: { provider: 'typesafe' },
      }),
      /BuildAgentDeps\.makeDecisionModel/,
    );
  });

  it('a decision: section alone builds nothing', async () => {
    let built = false;
    const r = await resolveReranker({
      decisionCfg: { provider: 'typesafe' },
      makeDecisionModel: async () => {
        built = true;
        return fakeModel;
      },
    });
    assert.equal(r, undefined);
    assert.equal(built, false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -E "resolve-reranker|^# fail"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

In `smart-server.ts` `BuildAgentDeps` (line 342), after `makeRag`:

```ts
  /**
   * Builds a decision model from the `decision:` section; the root resolves its
   * credentialRef. Optional: required only when the config asks for a decision
   * model (today: `reranker: { type: decision }`).
   */
  makeDecisionModel?: (cfg: SmartServerDecisionConfig) => Promise<IDecisionModel>;
```

(import `IDecisionModel` from `@mcp-abap-adt/llm-agent`.)

`SmartServer` does not keep `deps` — it copies seams by name into a private
`_deps` whose type is an explicit `Pick` (`smart-server.ts:978-992`, constructor
copy at `:1022-1036`). A seam added only to `BuildAgentDeps` is therefore a
compile error when read as `this._deps.makeDecisionModel`, and silently lost if
only the type is widened. Change both:

```ts
  // the second (optional) Pick of `_deps`:
    Pick<
      BuildAgentDeps,
      | 'skillHost'
      | 'embedder'
      | 'mcpClients'
      | 'connectMcpWithDescriptors'
      | 'makeDecisionModel'
    >;
```

```ts
      // in the constructor's `this._deps = { … }`, after connectMcpWithDescriptors:
      ...(deps.makeDecisionModel
        ? { makeDecisionModel: deps.makeDecisionModel }
        : {}),
```

Task 10's wiring tests are what prove the seam survives the copy (they fail with
"BuildAgentDeps.makeDecisionModel is required" if it is dropped).

`packages/llm-agent-server-libs/src/smart-agent/resolve-reranker.ts`:

```ts
import type { IDecisionModel, IReranker } from '@mcp-abap-adt/llm-agent';
import { DecisionReranker, wrapDecisionModel } from '@mcp-abap-adt/llm-agent-libs';
import type {
  SmartServerDecisionConfig,
  SmartServerRerankerConfig,
} from './decision-config.js';

export interface ResolveRerankerInput {
  rerankerCfg?: SmartServerRerankerConfig;
  decisionCfg?: SmartServerDecisionConfig;
  makeDecisionModel?: (cfg: SmartServerDecisionConfig) => Promise<IDecisionModel>;
  pluginReranker?: IReranker;
}

/**
 * The one reranker every agent of this server uses (§7.3). Configuration that
 * says something is never silently ignored: a YAML reranker next to a plugin
 * reranker is an error, as is a decision reranker without the seam to build it.
 */
export async function resolveReranker(
  input: ResolveRerankerInput,
): Promise<IReranker | undefined> {
  const { rerankerCfg, decisionCfg, makeDecisionModel, pluginReranker } = input;
  if (rerankerCfg && pluginReranker) {
    throw new Error(
      `reranker: ${rerankerCfg.type} is configured and a plugin reranker is loaded — choose one`,
    );
  }
  if (rerankerCfg?.type === 'decision') {
    if (!decisionCfg) {
      throw new Error('reranker.type: decision requires a decision: section');
    }
    if (!makeDecisionModel) {
      throw new Error(
        'BuildAgentDeps.makeDecisionModel is required: the config asks for a decision model, and the library constructs none from configuration. Supply it from your composition root.',
      );
    }
    return new DecisionReranker(
      wrapDecisionModel(await makeDecisionModel(decisionCfg)),
    );
  }
  return pluginReranker;
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsc -b packages/llm-agent-server-libs && npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Lint and commit**

```bash
npx biome check packages/llm-agent-server-libs/src
git add packages/llm-agent-server-libs/src
git commit -m "feat(server-libs): makeDecisionModel seam and resolveReranker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: SmartServer wiring — the reranker reaches session and embedded agents

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts`
  - hoisted field next to `_helperLlm` (~line 796): `private _reranker?: IReranker;`
  - `_buildInfra()` (~line 1157–1192): after the explicit `plugins: [...]` loop, before the pipeline registry: resolve once
  - `buildBaseBuilder()` (~line 2735–2742): `withReranker(this._reranker)` **outside** `if (parts.applyServerExtras)`; delete the gated `if (plugins?.reranker)` block
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/decision-reranker-wiring.test.ts`

**Interfaces:**
- Consumes: `resolveReranker` (Task 9), `resolveSmartServerConfig(args, yaml, env, options)`, `SmartServer`, `buildAgent(cfg, deps)`, `constructionSeams`, `stubLlm`.

- [ ] **Step 1: Write the failing tests**

`packages/llm-agent-server-libs/src/smart-agent/__tests__/decision-reranker-wiring.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type {
  DecisionRequest,
  IDecisionModel,
  IEmbedder,
  IRag,
  IReranker,
  RagResult,
} from '@mcp-abap-adt/llm-agent';
import { parse } from 'yaml';
import { resolveSmartServerConfig } from '../config.js';
import {
  type BuildAgentDeps,
  buildAgent,
  SmartServer,
  type SmartServerConfig,
} from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

// `rag:` is required: SmartServer builds the tools/history stores through the
// makeRag seam only when `cfg.rag` is set (smart-server.ts, `if (this.cfg.rag)`),
// and without a store the rerank stage never runs.
const BASE_YAML = `
llm:
  provider: openai
  model: gpt-4o
rag:
  store:
    type: in-memory
`;
const YAML = `${BASE_YAML}decision:
  provider: typesafe
reranker:
  type: decision
`;
const QUERY = 'find the passage';
const stubEmbedder = {
  embed: async () => ({ vector: [1, 0] }),
} as unknown as IEmbedder;

/** The passages the reranker was asked about, in question order. */
function passagesOf(req: DecisionRequest): unknown[] {
  return Object.values(req.questions).map((q) =>
    q.type === 'noul' && q.instructions && typeof q.instructions === 'object'
      ? (q.instructions as { passage?: unknown }).passage
      : undefined,
  );
}

const HITS: RagResult[] = [
  { text: 'passage one', metadata: { id: '1' }, score: 0.5 },
  { text: 'passage two', metadata: { id: '2' }, score: 0.4 },
];

/** Every store returns HITS, so the rerank stage has something to rerank. */
const makeRag: BuildAgentDeps['makeRag'] = async (input) => {
  const rag = (await constructionSeams.makeRag(input)) as IRag;
  rag.query = async () => ({ ok: true, value: [...HITS] });
  return rag;
};

function recordingModel() {
  const seen: DecisionRequest[] = [];
  const model: IDecisionModel = {
    decide: async (req) => {
      seen.push(req);
      const answers: Record<string, { type: 'noul'; probability: number }> = {};
      Object.keys(req.questions).forEach((k, i) => {
        answers[k] = { type: 'noul', probability: 1 - i * 0.1 };
      });
      return { ok: true, value: { model: 'fake', answers } };
    },
  };
  return { model, seen };
}

function configFrom(text: string): SmartServerConfig {
  return {
    ...resolveSmartServerConfig({}, parse(text), {}, {
      skipProviderRuntimeChecks: true,
    }),
    port: 0,
    skipModelValidation: true,
  } as SmartServerConfig;
}

function post(port: number, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

describe('decision reranker wiring (§7.4)', () => {
  it('HTTP: a chat request on a session reaches the decision model', async () => {
    const { model, seen } = recordingModel();
    const server = new SmartServer(configFrom(YAML), {
      ...constructionSeams,
      makeRag,
      embedder: stubEmbedder,
      makeDecisionModel: async () => model,
    });
    const handle = await server.start();
    try {
      const status = await post(handle.port, '/v1/chat/completions', {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: QUERY }],
      });
      assert.equal(status, 200);
      assert.ok(seen.length >= 1, 'the per-session agent must rerank');
      assert.equal(seen[0].state, QUERY);
      assert.deepEqual(passagesOf(seen[0]), HITS.map((h) => h.text));
    } finally {
      await handle.close();
    }
  });

  it('embedded buildAgent(): the same YAML reaches the decision model', async () => {
    const { model, seen } = recordingModel();
    const { agent, close } = await buildAgent(configFrom(YAML), {
      ...constructionSeams,
      makeRag,
      embedder: stubEmbedder,
      makeDecisionModel: async () => model,
    });
    try {
      await agent.process(QUERY);
      assert.ok(seen.length >= 1, 'the embedded agent must rerank');
      assert.equal(seen[0].state, QUERY);
      assert.deepEqual(passagesOf(seen[0]), HITS.map((h) => h.text));
    } finally {
      await close();
    }
  });

  it('regression: a plugin reranker reaches the session agent', async () => {
    const calls: Array<{ query: string; texts: string[] }> = [];
    const plugin: IReranker = {
      rerank: async (query, r) => {
        calls.push({ query, texts: r.map((x) => x.text) });
        return { ok: true, value: r };
      },
    };
    // An absolute path: smart-server resolves `plugins: [...]` specifiers as
    // './' (cwd-relative), '/' (absolute) or a package name. The module's
    // `reranker` export is what mergePluginExports picks up (plugins/types.ts).
    const dir = mkdtempSync(join(tmpdir(), 'rr-plugin-'));
    const pluginPath = join(dir, 'reranker-plugin.mjs');
    writeFileSync(
      pluginPath,
      'export const reranker = globalThis.__decisionWiringPlugin;\n',
    );
    (globalThis as Record<string, unknown>).__decisionWiringPlugin = plugin;
    const cfg = {
      ...configFrom(BASE_YAML),
      plugins: [pluginPath],
    } as SmartServerConfig;
    const server = new SmartServer(cfg, {
      ...constructionSeams,
      makeRag,
      embedder: stubEmbedder,
    });
    const handle = await server.start();
    try {
      await post(handle.port, '/v1/chat/completions', {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: QUERY }],
      });
      assert.ok(calls.length >= 1, 'a plugin reranker was a silent no-op on sessions');
      assert.equal(calls[0].query, QUERY);
      assert.deepEqual(calls[0].texts, HITS.map((h) => h.text));
    } finally {
      await handle.close();
      delete (globalThis as Record<string, unknown>).__decisionWiringPlugin;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Notes for the implementer:
- `seen[0].state` must equal `QUERY` exactly. If it does not, a stage before
  rerank rewrote `ctx.ragText` (classification or translation): report which
  stage and what it produced — do not loosen the assertion.
- Verified while planning: the chat route is `/v1/chat/completions` (`smart-server.ts:3140`); a plugin module's reranker export is named `reranker` (`llm-agent-libs/src/plugins/types.ts:104`).
- If the flat pipeline answers the stub LLM's `'ok'` through a path that skips RAG (e.g. classification short-circuits), confirm with `DEBUG`-less logging which stages ran; the rerank stage is `rag-retrieval → after: rerank` in `default-pipeline.ts:363-370` and needs a non-empty `ragResults` store. `tools` and `history` stores are both built through `makeRag` (`smart-server.ts:1411-1412`), so the override above feeds them.

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -E "decision-reranker-wiring|not ok|^# fail"`
Expected: the HTTP, embedded and plugin tests FAIL (`seen.length` 0, `called` 0).

- [ ] **Step 3: Implement**

In `smart-server.ts`:

1. Import: `import { resolveReranker } from './resolve-reranker.js';` and `type IReranker` from `@mcp-abap-adt/llm-agent`.
2. Hoisted field after `private _helperLlm?: ILlm;`:

```ts
  /** The one reranker of this server, resolved once in `_buildInfra()` (§7.4). */
  private _reranker?: IReranker;
```

3. In `_buildInfra()`, right after the `for (const spec of this.cfg.plugins ?? [])` loop ends and before `// ---- Pipeline-plugin registry`:

```ts
    // ---- Reranker (§7.4) -------------------------------------------------
    // Resolved ONCE here — the infra build shared by start() and the embeddable
    // buildAgent() — and applied by buildBaseBuilder outside the
    // applyServerExtras gate, so per-session agents get it too.
    this._reranker = await resolveReranker({
      rerankerCfg: this.cfg.reranker,
      decisionCfg: this.cfg.decision,
      makeDecisionModel: this._deps.makeDecisionModel,
      pluginReranker: plugins.reranker,
    });
```

4. In `buildBaseBuilder()`: delete

```ts
      if (plugins?.reranker) {
        builder = builder.withReranker(plugins.reranker);
      }
```

and, immediately before `if (parts.applyServerExtras) {` (~line 2735), add:

```ts
    // Not gated: requests are served by per-session agents, built with
    // applyServerExtras=false; the startup agent is infrastructure only.
    if (this._reranker) {
      builder = builder.withReranker(this._reranker);
    }
```

5. Update the `buildBaseBuilder` doc comment: remove "reranker" from the list of gated extras and add one line: "The reranker is not gated (§7.4)."

- [ ] **Step 4: Run tests**

Run: `npx tsc -b packages/llm-agent-server-libs && npm test --workspace @mcp-abap-adt/llm-agent-server-libs 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Open the follow-up issue (out of scope, spec §7.4)**

Draft only — show the user before creating (outward-facing):

```bash
gh issue create --title "queryExpander and outputValidator never reach per-session agents" --body "buildBaseBuilder applies plugins.queryExpander / plugins.outputValidator only inside if (parts.applyServerExtras); per-session agents are built with applyServerExtras=false, so both are silent no-ops on real requests. The reranker had the same defect and was moved outside the gate in the decision-model work (spec §7.4)."
```

- [ ] **Step 6: Lint and commit**

```bash
npx biome check packages/llm-agent-server-libs/src
git add packages/llm-agent-server-libs/src
git commit -m "fix(server-libs): the reranker reaches per-session and embedded agents

Resolved once in _buildInfra and wired outside the applyServerExtras gate.
A plugin reranker was a silent no-op on session requests; it now runs.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Binary — `makeDecisionModel` composition, dependency, build graph, publish list

**Files:**
- Create: `packages/llm-agent-server/src/composition/make-decision-model.ts`
- Modify: `packages/llm-agent-server/src/composition/credential-for.ts:29-31` (`DEFAULT_DECISION_REF`)
- Modify: `packages/llm-agent-server/src/composition/index.ts` (`CompositionDeps`, `buildCompositionDeps`)
- Modify: `packages/llm-agent-server/package.json` (`dependencies`: `"@mcp-abap-adt/typesafe-decision": "^30.0.0"`)
- Modify: `packages/llm-agent-server/tsconfig.json` (`references`: `{ "path": "../typesafe-decision" }`)
- Modify: `scripts/publish-all.sh` (`PACKAGES`: `typesafe-decision` after `pg-vector-rag`)
- Test: `packages/llm-agent-server/src/composition/__tests__/make-decision-model.test.ts`

**Interfaces:**
- Consumes: `Lookup` (`lookup(ref, roleDefault, target).require('api-key')`), `TypeSafeDecisionModel`, `SmartServerDecisionConfig`.
- Produces: `createMakeDecisionModel(lookup, ctors?): (cfg) => Promise<IDecisionModel>`; `DecisionProviderCtors { typesafe: new (cfg: TypeSafeDecisionConfig) => IDecisionModel }`; `SHIPPED_DECISION_PROVIDERS`; `DEFAULT_DECISION_REF = 'DECISION'`.

- [ ] **Step 1: Write the failing tests**

`packages/llm-agent-server/src/composition/__tests__/make-decision-model.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import {
  type CredentialEntry,
  DEFAULT_DECISION_REF,
  memoizeCredentials,
} from '../credential-for.js';
import { createLookup } from '../lookup.js';
import {
  createMakeDecisionModel,
  type DecisionProviderCtors,
} from '../make-decision-model.js';

function harness(entries: Record<string, CredentialEntry>) {
  const seen: Array<Record<string, unknown>> = [];
  const ctors = {
    typesafe: class {
      constructor(cfg: Record<string, unknown>) {
        seen.push(cfg);
      }
      async decide() {
        return { ok: true, value: { model: 'f', answers: {} } };
      }
    },
  } as unknown as DecisionProviderCtors;
  const make = createMakeDecisionModel(
    createLookup(memoizeCredentials((r) => entries[r])),
    ctors,
  );
  return { seen, make };
}

describe('makeDecisionModel', () => {
  it("the default ref is 'DECISION'", async () => {
    assert.equal(DEFAULT_DECISION_REF, 'DECISION');
    const cred = staticApiKey('k');
    const { seen, make } = harness({ DECISION: { credential: cred } });
    await make({ provider: 'typesafe' });
    assert.equal(seen[0].credential, cred);
  });

  it('a named ref is used, and credentialRef never reaches the provider', async () => {
    const cred = staticApiKey('k2');
    const { seen, make } = harness({ TYPESAFE: { credential: cred } });
    await make({ provider: 'typesafe', credentialRef: 'TYPESAFE' });
    assert.equal(seen[0].credential, cred);
    assert.equal('credentialRef' in seen[0], false);
    assert.equal('provider' in seen[0], false);
  });

  it('absent optionals stay absent; maxRetries: 0 is forwarded', async () => {
    const { seen, make } = harness({
      DECISION: { credential: staticApiKey('k') },
    });
    await make({ provider: 'typesafe', maxRetries: 0 });
    assert.deepEqual(Object.keys(seen[0]).sort(), ['credential', 'maxRetries']);
    assert.equal(seen[0].maxRetries, 0);
  });

  it('every knob arrives by name', async () => {
    const { seen, make } = harness({
      DECISION: { credential: staticApiKey('k') },
    });
    await make({
      provider: 'typesafe',
      model: 'jev-1.13.0',
      baseUrl: 'https://p.example',
      timeoutMs: 5000,
      maxRetries: 3,
    });
    assert.equal(seen[0].model, 'jev-1.13.0');
    assert.equal(seen[0].baseUrl, 'https://p.example');
    assert.equal(seen[0].timeoutMs, 5000);
    assert.equal(seen[0].maxRetries, 3);
  });

  it('a non-api-key credential is refused, naming the ref', async () => {
    const bearer: IBearerCredential = { kind: 'bearer', token: async () => 't' };
    const { make } = harness({ DECISION: { credential: bearer } });
    await assert.rejects(
      make({ provider: 'typesafe' }),
      /credentialRef 'DECISION' must hold a api-key credential/,
    );
  });

  it('an unknown provider is refused', async () => {
    const { make } = harness({ DECISION: { credential: staticApiKey('k') } });
    await assert.rejects(
      make({ provider: 'nope' as never }),
      /unknown decision provider 'nope'/,
    );
  });
});
```

Also extend `packages/llm-agent-server/src/composition/__tests__/credentials.test.ts` only if it enumerates `CompositionDeps` keys (check with `grep -n "makeRag" …/credentials.test.ts`); if it does, add `makeDecisionModel` to the expected list.

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server 2>&1 | grep -E "make-decision-model|^# fail"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`credential-for.ts`, after `DEFAULT_EMBEDDER_REF`:

```ts
export const DEFAULT_DECISION_REF = 'DECISION';
```

`packages/llm-agent-server/src/composition/make-decision-model.ts`:

```ts
import type { IDecisionModel } from '@mcp-abap-adt/llm-agent';
import type { SmartServerDecisionConfig } from '@mcp-abap-adt/llm-agent-server-libs';
import {
  type TypeSafeDecisionConfig,
  TypeSafeDecisionModel,
} from '@mcp-abap-adt/typesafe-decision';
import { DEFAULT_DECISION_REF } from './credential-for.js';
import type { Lookup } from './lookup.js';

/** Injectable so a test records what each constructor receives. */
export interface DecisionProviderCtors {
  typesafe: new (cfg: TypeSafeDecisionConfig) => IDecisionModel;
}

export const SHIPPED_DECISION_PROVIDERS: DecisionProviderCtors = {
  typesafe: TypeSafeDecisionModel,
};

/**
 * `BuildAgentDeps.makeDecisionModel`. The provider config is built from NAMED
 * fields — nothing spreads `cfg` — so `credentialRef` cannot ride along, and an
 * optional field absent from the section stays absent (unset is not sent).
 */
export function createMakeDecisionModel(
  lookup: Lookup,
  ctors: DecisionProviderCtors = SHIPPED_DECISION_PROVIDERS,
): (cfg: SmartServerDecisionConfig) => Promise<IDecisionModel> {
  return async (cfg) => {
    switch (cfg.provider) {
      case 'typesafe': {
        const credential = lookup(
          cfg.credentialRef,
          DEFAULT_DECISION_REF,
          'decision typesafe',
        ).require('api-key');
        return new ctors.typesafe({
          credential,
          ...(cfg.model !== undefined ? { model: cfg.model } : {}),
          ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(cfg.maxRetries !== undefined
            ? { maxRetries: cfg.maxRetries }
            : {}),
        });
      }
      default:
        throw new Error(
          `unknown decision provider '${String((cfg as { provider?: unknown }).provider)}'`,
        );
    }
  };
}
```

`composition/index.ts`:

```ts
import { createMakeDecisionModel } from './make-decision-model.js';

export type CompositionDeps = Pick<
  BuildAgentDeps,
  'makeLlm' | 'resolveEmbedder' | 'makeRag'
> & {
  buildSkillHost: NonNullable<BuildAgentDeps['buildSkillHost']>;
  makeDecisionModel: NonNullable<BuildAgentDeps['makeDecisionModel']>;
};
```

and in `buildCompositionDeps` add `makeDecisionModel: createMakeDecisionModel(lookup),`.

`packages/llm-agent-server/package.json` `dependencies` — insert alphabetically after `"@mcp-abap-adt/sap-aicore-llm"`:

```json
    "@mcp-abap-adt/typesafe-decision": "^30.0.0",
```

`packages/llm-agent-server/tsconfig.json` `references` — add `{ "path": "../typesafe-decision" }` after `../sap-aicore-auth`.

`scripts/publish-all.sh` `PACKAGES` — add `  typesafe-decision` on the line after `  pg-vector-rag`.

Run `npm install` (workspace link for the sibling; registry for the SDK), then:

```bash
grep -n '"node_modules/@typesafe-ai/sdk"' -A3 package-lock.json | grep -E 'resolved|link'
```

Expected: a registry `resolved` URL, no `"link": true`.

- [ ] **Step 4: Run tests and a full build**

Run: `npm run build 2>&1 | tail -5 && npm test --workspace @mcp-abap-adt/llm-agent-server 2>&1 | grep -E "^# (pass|fail)"`
Expected: build clean; `# fail 0`.

- [ ] **Step 5: Lint and commit**

```bash
npx biome check packages/llm-agent-server scripts/publish-all.sh
git add packages/llm-agent-server scripts/publish-all.sh package-lock.json
git commit -m "feat(server): makeDecisionModel composition over TypeSafe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Live integration test (env-gated)

**Files:**
- Create: `test/integration/typesafe-decision/typesafe-decision.integration.test.ts`
- Modify: root `package.json` scripts: `"test:integration:decision": "node --import tsx/esm --test --test-reporter=spec 'test/integration/typesafe-decision/*.test.ts'"`

**Interfaces:**
- Consumes: `TypeSafeDecisionModel`, `DecisionReranker`, `staticApiKey`.

- [ ] **Step 1: Write the test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type RagResult, staticApiKey } from '@mcp-abap-adt/llm-agent';
import { DecisionReranker } from '@mcp-abap-adt/llm-agent-libs';
import { TypeSafeDecisionModel } from '@mcp-abap-adt/typesafe-decision';

const KEY = process.env.DECISION_API_KEY;
const describeLive = KEY ? describe : describe.skip;

describeLive('TypeSafe Jev — live (DECISION_API_KEY)', () => {
  const model = new TypeSafeDecisionModel({ credential: staticApiKey(KEY ?? '') });

  it('answers one question of each type', async () => {
    const r = await model.decide({
      state: 'I was charged twice for my subscription this month.',
      questions: {
        billing: { type: 'noul', instructions: 'Is this about billing?' },
        team: {
          type: 'choice',
          instructions: 'Which team should handle this?',
          criteria: { billing: 'Payments', technical: 'Bugs', sales: 'Pricing' },
        },
        urgency: {
          type: 'score',
          instructions: 'How urgent is this?',
          criteria: ['Not urgent', 'Somewhat urgent', 'Very urgent'],
        },
      },
    });
    assert.ok(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`);
    assert.ok(r.value.answers.billing.type === 'noul');
    assert.ok(r.value.answers.team.type === 'choice');
    assert.ok(r.value.answers.urgency.type === 'score');
    console.log(JSON.stringify(r.value, null, 2));
  });

  it('reranking puts the relevant passage first (spec §6.1 quality check)', async () => {
    const passages: RagResult[] = [
      { text: 'The cafeteria opens at 8am on weekdays.', metadata: { id: 'x1' }, score: 0.9 },
      { text: 'Parking permits are renewed every January.', metadata: { id: 'x2' }, score: 0.85 },
      {
        text: 'To reset your password, open Settings → Security and choose "Reset password"; a link is emailed to you.',
        metadata: { id: 'hit' },
        score: 0.5,
      },
      { text: 'The office plants are watered on Fridays.', metadata: { id: 'x3' }, score: 0.8 },
    ];
    const r = await new DecisionReranker(model).rerank(
      'How do I reset my password?',
      passages,
    );
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    console.log(r.value.map((p) => `${p.metadata.id} ${p.score.toFixed(3)}`).join('\n'));
    assert.equal(r.value[0].metadata.id, 'hit');
  });
});
```

- [ ] **Step 2: Run without the key (must skip, not fail)**

Run: `npm run build && env -u DECISION_API_KEY npm run test:integration:decision 2>&1 | tail -5`
Expected: tests reported as skipped; exit 0.

- [ ] **Step 3: Run live (only with the user's go-ahead — outward-facing, sends data to TypeSafe)**

Ask the user first. Then: `DECISION_API_KEY=… npm run test:integration:decision`. Record the printed scores in the PR description. If the relevant passage is not first, stop and report — the §6.1 design choice ("query as state, passages as questions") is then in question and goes back to the user, not patched in the test.

- [ ] **Step 4: Lint and commit**

```bash
npx biome check test/integration/typesafe-decision package.json
git add test/integration/typesafe-decision package.json
git commit -m "test(integration): live TypeSafe decision + rerank check, gated on DECISION_API_KEY

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Documentation — the whole set

**Files (modify unless noted):** `README.md`, `docs/ARCHITECTURE.md`, `docs/EXAMPLES.md`, `docs/INTEGRATION.md`, `docs/QUICK_START.md`, `.env.template`, `docs/PERFORMANCE.md`, `docs/DEPLOYMENT.md`, `docs/TROUBLESHOOTING.md`, `docs/SECURITY_THREAT_MODEL.md`, `CLAUDE.md`, `CHANGELOG.md` (root) and each changed package's `CHANGELOG.md`.

Every concrete claim (type name, key, env var, path, default) is copied from the code written in Tasks 1–12, then grepped back against source before commit.

- [ ] **Step 1: Find every place that already talks about rerankers or lists packages**

```bash
grep -n -i "rerank" README.md docs/*.md | cut -c1-120
grep -n "pg-vector-rag\|six npm packages\|publishes" README.md CLAUDE.md docs/ARCHITECTURE.md | cut -c1-120
```

- [ ] **Step 2: Write the changes**

- `README.md`: package table gains `@mcp-abap-adt/typesafe-decision` ("decision model provider — TypeSafe Jev"); a short "Decision models" paragraph: not an LLM, numbers only, first consumer is the reranker, YAML snippet from spec §7.1.
- `docs/ARCHITECTURE.md`: layer table — `IDecisionModel` next to `ILlm`/`IEmbedder` in the contracts row; reranker seam: `reranker:` YAML or plugin (exclusive), resolved once in `_buildInfra`, wired outside `applyServerExtras` (one paragraph); package list.
- `docs/EXAMPLES.md`: the YAML from spec §7.1; programmatic:

```ts
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { DecisionReranker, SmartAgentBuilder, wrapDecisionModel } from '@mcp-abap-adt/llm-agent-libs';
import { TypeSafeDecisionModel } from '@mcp-abap-adt/typesafe-decision';

const model = wrapDecisionModel(
  new TypeSafeDecisionModel({ credential: staticApiKey(process.env.DECISION_API_KEY ?? '') }),
);
const builder = new SmartAgentBuilder({ /* … */ }).withReranker(new DecisionReranker(model));
```

  (verify `SmartAgentBuilder` constructor usage against an existing EXAMPLES.md snippet and copy its shape.)
- `docs/INTEGRATION.md`: "Implementing `IDecisionModel`" — the interface, the `Result` rule, unsupported → `DECISION_UNSUPPORTED_QUESTION`, the numeric invariants, abort → `DECISION_ABORTED`; a minimal fake implementation (the one from Task 6's test).
- `docs/QUICK_START.md` and `.env.template`: `DECISION_API_KEY` (and `<REF>_API_KEY` with `decision.credentialRef`).
- `docs/PERFORMANCE.md`, `docs/DEPLOYMENT.md`: reranking sections — decision reranker = one request per RAG store per chat request, latency ≈ one question; plugin and YAML rerankers are exclusive.
- `docs/TROUBLESHOOTING.md`: "Reranking has no effect" → check span attribute `<store>.rerank_error` / session step `rerank_error`; `DECISION_AUTH` → key; `DECISION_RATE_LIMITED` → 1 200 req/min quota; startup errors from §7.1/§7.3 with their exact messages.
- `docs/SECURITY_THREAT_MODEL.md`: new attack-surface entry "AS-7: Data sent to a third-party decision model" — with `reranker.type: decision`, the user query and the retrieved passages are sent to TypeSafe's API; mitigation: opt-in only, SDK logging forced off, keys from env by ref, no request body in error messages.
- `CLAUDE.md`: architecture list (the new package and its place in the dependency order), env table (`DECISION_API_KEY`).
- `CHANGELOG.md` (root, `## Unreleased`): *Added* — `IDecisionModel`, `@mcp-abap-adt/typesafe-decision`, `DecisionReranker`, `wrapDecisionModel`, `decision:`/`reranker:` YAML, `makeDecisionModel` seam; *Changed* — `LlmComponent` gains `'decision'` (an exhaustive `switch` sees a new case), `RerankHandler` records failures; *Fixed* — a plugin reranker never ran on per-session agents.
- Package `CHANGELOG.md`s (`llm-agent`, `llm-agent-libs`, `llm-agent-server-libs`, `llm-agent-server`): one `## Unreleased` line each for their part.

- [ ] **Step 3: Verify claims against source**

```bash
for s in IDecisionModel DecisionReranker wrapDecisionModel makeDecisionModel DEFAULT_DECISION_REF rerank_error TypeSafeDecisionModel; do
  printf '%-24s src:%s docs:%s\n' "$s" \
    "$(grep -rl "$s" packages/*/src | wc -l)" \
    "$(grep -l "$s" README.md CLAUDE.md docs/*.md | wc -l)"
done
node scripts/check-example-configs.mjs
```

Expected: every symbol named in docs exists in `src`; the example-config check passes.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md CHANGELOG.md .env.template docs packages/*/CHANGELOG.md
git commit -m "docs: decision models — README, architecture, examples, integration, ops, security

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Release gates (no publish)

**Files:** none new; verification plus the version bump commit.

- [ ] **Step 1: Clean-checkout build (spec §8.1)**

`feat/decision-model` is checked out in the main working tree, so a second
worktree cannot check it out again — use a detached worktree at `HEAD`, and run
nothing unless it was created:

```bash
set -euo pipefail
git status --porcelain | grep -q . && { echo "commit first: the worktree sees HEAD only"; exit 1; }
D=$(mktemp -d)
git worktree add --detach "$D" HEAD
trap 'git worktree remove --force "$D"' EXIT
( cd "$D" && test ! -e packages/llm-agent/dist && npm ci && npm run build && npm run typecheck && npm test ) 2>&1 | tail -15
```

Expected: exit 0 — build, typecheck and tests green with no pre-existing `dist/`.

- [ ] **Step 2: CI matrix locally (Node 22 and 24)**

```bash
set -o pipefail
for v in 22 24; do
  docker run --rm -v "$PWD":/src:ro node:$v bash -c \
    'set -euo pipefail; mkdir /work && cd /work && cp -a /src/. . && rm -rf node_modules packages/*/node_modules packages/*/dist packages/*/tsconfig.tsbuildinfo && npm ci && npm run build && npm run typecheck && npm test' \
    2>&1 | tail -6 || { echo "node:$v FAILED"; exit 1; }
done
```

Expected: exit 0, green on both. A red leg is investigated against `main` (`git stash` is not used; check out `main` in a separate worktree) before calling anything "pre-existing".

- [ ] **Step 3: Baseline diff vs main**

Run the full `npm test` on a `main` worktree and on the branch; compare pass/fail counts. Every new failure is ours.

- [ ] **Step 4: Bump the version (only after the PR is reviewed and the user says to prepare the release)**

```bash
node scripts/bump-version.mjs 30.1.0
grep -rn '"version"' packages/*/package.json | grep -v 30.1.0   # expect nothing
grep -rn '"@mcp-abap-adt/[^"]*": "' packages/*/package.json | grep -v '\^30.1.0\|\^2.1.0\|\^1.1.0' # expect nothing
grep -rn '"file:\|"link:\|"workspace:' packages/*/package.json   # expect nothing
```

Move the root and package `## Unreleased` CHANGELOG headings to `## 30.1.0`. Commit `chore(release): 30.1.0`.

- [ ] **Step 5: Hand over**

Publishing is the user's (`npm run release:publish`, yubikey). After it: a clean install of `@mcp-abap-adt/llm-agent-server@30.1.0` from the registry in a temp dir (`npm i @mcp-abap-adt/llm-agent-server@30.1.0` in an empty `mktemp -d`), and `npm view @mcp-abap-adt/typesafe-decision@30.1.0 version`.
