# Text-Logger Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a consumer hand its ordinary text logger to llm-agent, instead of writing a `LogEvent` adapter first — without changing the logger type llm-agent hands back out.

**Architecture:** `ITextLogger` is added as a re-export of `@mcp-abap-adt/interfaces-utils`' `ILogger` (`info`/`error`/`warn`/`debug`). Every seam that *accepts* a logger widens to `ILogger | ITextLogger` and normalises once, at the boundary, through one internal adapter that turns a `LogEvent` into a levelled text call. Every seam that *hands a logger out* — `IPipelineContext.logger`, `IPipelinePlugin` — keeps the existing `ILogger`, so consumer plugins that call `logger.log({...})` keep compiling.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), npm workspaces, `node:test` via `tsx` (`node --import tsx/esm --test 'src/**/*.test.ts'` per package), Biome, `tsc -b` project references.

**Spec:** `docs/superpowers/specs/2026-09-16-auth-contracts-design.md` (§7; workstream 4 of §10)

## Global Constraints

- **Additive minor.** Nothing is removed; no existing path changes behaviour. A consumer that keeps passing an `ILogger` sees exactly today's behaviour, and no pre-existing test may need editing.
- **The exported `ILogger` is FROZEN.** It stays `{ log(event: LogEvent): void }` in `packages/llm-agent/src/logger/types.ts`. Do not widen it, rename it, or add members — `IPipelineContext.logger` and `IPipelinePlugin` hand this exact type to consumer plugins, so changing its shape is a major.
- **Output seams stay `ILogger`:** `packages/llm-agent/src/interfaces/pipeline-plugin.ts` — `IPipelineContext` (declared at :46, its `logger?: ILogger` at :68) and `IPipelinePlugin` (:91). These files are not to be touched by this workstream.
- **Input seams widen to `ILogger | ITextLogger`:** `SmartAgentBuilder.withLogger` (`llm-agent-libs/src/builder.ts:386`), `ConnectionStrategyOptions.logger` (`llm-agent/src/interfaces/mcp-connection-strategy.ts:76`), `SessionGraphFactoryOptions.logger` (`llm-agent-libs/src/session/session-graph-factory.ts:107`), embedder resilience (`llm-agent/src/resilience/embedder-resilience.ts:67`), session lifecycle (`llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts:72`).
- **`@mcp-abap-adt/interfaces-utils` becomes a REGULAR dependency** of `@mcp-abap-adt/llm-agent` (currently absent). The import is type-only, which keeps it out of the runtime graph, but a re-exported type must resolve in every consumer's `tsc` — a devDependency would break them. Published version: `1.0.0`.
- **The boundary mapping is fixed by §7** and must be implemented exactly:

  | rule | value |
  |---|---|
  | message | `event.type`, except `warning`, where it is `event.message` |
  | meta | the whole `event` |
  | `pipeline_error` | `error` |
  | `warning` | `warn` |
  | `rag_upsert`, `rag_query`, `tools_selected` | `debug` |
  | everything else | `info` |

- **Two logger names is the accepted residue.** Convergence to one name is a rename, and a rename is a major (§9.9). Do not "clean this up" by unifying them.
- All artifacts in English. Conventional Commits. Commit after every task.

---

## File structure

| file | responsibility |
|---|---|
| `packages/llm-agent/src/logger/text-logger.ts` | **new** — the `ITextLogger` re-export, nothing else |
| `packages/llm-agent/src/logger/to-text-logger.ts` | **new** — the boundary adapter: `AnyLogger` → `ILogger`, plus the level mapping |
| `packages/llm-agent/src/logger/to-text-logger.test.ts` | **new** — one assertion per `LogEvent` kind, beside its source |
| `packages/llm-agent/src/logger/types.ts` | untouched — the frozen `ILogger` and `LogEvent` live here |
| `packages/llm-agent/src/index.ts` | export `ITextLogger`, `AnyLogger`, `normaliseLogger` |
| `packages/llm-agent/package.json` | add the `interfaces-utils` dependency |
| `packages/llm-agent/src/interfaces/mcp-connection-strategy.ts` | `ConnectionStrategyOptions.logger` widens |
| `packages/llm-agent/src/resilience/embedder-resilience.ts` | its `logger` option widens |
| `packages/llm-agent-mcp/src/strategies/lazy-connection-strategy.ts` | normalises the widened `ConnectionStrategyOptions.logger` at `:49`, where it stores it |
| `packages/llm-agent-rag/src/rag-factories.ts` | `EmbedderResolutionOptions.logger` (:138) and `RagResolutionOptions.logger` (:255) widen — both are public, both exported from that package's barrel |
| `packages/llm-agent-libs/src/builder.ts` | `withLogger` widens; normalise once, at the setter |
| `packages/llm-agent-libs/src/session/session-graph-factory.ts` | `SessionGraphFactoryOptions.logger` widens; normalise in the constructor |
| `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts` | `SessionLifecycleOptions.logger` widens; forwarded as-is |
| `CHANGELOG.md`, `docs/INTEGRATION.md` | what a consumer gains, and the two-names residue stated plainly |

---

### Task 1: `ITextLogger` and the boundary adapter

**Files:**
- Create: `packages/llm-agent/src/logger/text-logger.ts`
- Create: `packages/llm-agent/src/logger/to-text-logger.ts`
- Create: `packages/llm-agent/src/logger/to-text-logger.test.ts`
- Modify: `packages/llm-agent/package.json` (dependencies)
- Modify: `packages/llm-agent/src/index.ts` (the logger export line is :76)

**Interfaces:**
- Consumes: `ILogger`, `LogEvent` from `./logger/types.js` (unchanged); `ILogger` from `@mcp-abap-adt/interfaces-utils` (renamed on re-export).
- Produces — every later task depends on these exact names:
  - `type ITextLogger` — the `interfaces-utils` shape: `info/error/warn/debug(message: string, meta?: unknown): void`
  - `type AnyLogger = ILogger | ITextLogger`
  - `function normaliseLogger(logger: AnyLogger): ILogger`
  - `function isTextLogger(logger: AnyLogger): logger is ITextLogger`

- [ ] **Step 1: Add the dependency**

In `packages/llm-agent/package.json`, add to `dependencies` (NOT devDependencies — the re-exported type must resolve in every consumer's `tsc`):

```json
    "@mcp-abap-adt/interfaces-utils": "^1.0.0"
```

Then install from the repo root: `npm install`.

- [ ] **Step 2: Write the failing test**

Create `packages/llm-agent/src/logger/to-text-logger.test.ts`. It sits beside its source, like the existing `src/interfaces/assert-client-descriptors.test.ts`.

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LogEvent } from './types.js';
import { isTextLogger, normaliseLogger } from './to-text-logger.js';
import type { ITextLogger } from './text-logger.js';

type Call = { level: string; message: string; meta?: unknown };

function recordingTextLogger(): { logger: ITextLogger; calls: Call[] } {
  const calls: Call[] = [];
  const push = (level: string) => (message: string, meta?: unknown) => {
    calls.push({ level, message, meta });
  };
  return {
    calls,
    logger: {
      info: push('info'),
      error: push('error'),
      warn: push('warn'),
      debug: push('debug'),
    },
  };
}

describe('normaliseLogger', () => {
  it('returns an event logger unchanged — the existing path must not move', () => {
    const events: LogEvent[] = [];
    const eventLogger = { log: (e: LogEvent) => void events.push(e) };

    const normalised = normaliseLogger(eventLogger);

    assert.equal(normalised, eventLogger);
  });

  it('maps every LogEvent kind to the level §7 specifies', () => {
    const { logger, calls } = recordingTextLogger();
    const sink = normaliseLogger(logger);

    const events: LogEvent[] = [
      { type: 'classify', traceId: 't', inputLength: 1, subpromptCount: 1, durationMs: 1 },
      { type: 'rag_upsert', traceId: 't', store: 's', durationMs: 1 },
      { type: 'rag_query', traceId: 't', store: 's', k: 1, resultCount: 1, durationMs: 1 },
      { type: 'llm_call', traceId: 't', iteration: 1, finishReason: 'stop', durationMs: 1 },
      { type: 'tool_call', traceId: 't', toolName: 'x', isError: false, durationMs: 1 },
      { type: 'pipeline_done', traceId: 't', stopReason: 'done', iterations: 1, toolCallCount: 0, durationMs: 1 },
      { type: 'pipeline_error', traceId: 't', code: 'E', message: 'boom', durationMs: 1 },
      { type: 'tools_selected', traceId: 't', total: 5, selected: 2, names: ['a', 'b'] },
      { type: 'rag_translate', traceId: 't', original: 'a', translated: 'b' },
      { type: 'warning', traceId: 't', message: 'careful' },
    ];
    for (const event of events) sink.log(event);

    assert.deepEqual(
      calls.map((c) => c.level),
      [
        'info',  // classify
        'debug', // rag_upsert
        'debug', // rag_query
        'info',  // llm_call
        'info',  // tool_call
        'info',  // pipeline_done
        'error', // pipeline_error
        'debug', // tools_selected
        'info',  // rag_translate
        'warn',  // warning
      ],
    );
  });

  it('uses event.type as the message, except for warning', () => {
    const { logger, calls } = recordingTextLogger();
    const sink = normaliseLogger(logger);

    sink.log({ type: 'llm_call', traceId: 't', iteration: 1, finishReason: 'stop', durationMs: 1 });
    sink.log({ type: 'warning', traceId: 't', message: 'careful' });

    assert.equal(calls[0].message, 'llm_call');
    assert.equal(calls[1].message, 'careful');
  });

  it('passes the whole event as meta, including for warning', () => {
    const { logger, calls } = recordingTextLogger();
    const sink = normaliseLogger(logger);
    const event: LogEvent = { type: 'warning', traceId: 't', message: 'careful' };

    sink.log(event);

    assert.deepEqual(calls[0].meta, event);
  });
});

describe('isTextLogger', () => {
  it('recognises a text logger and rejects an event logger', () => {
    const { logger } = recordingTextLogger();
    assert.equal(isTextLogger(logger), true);
    assert.equal(isTextLogger({ log: () => {} }), false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test -w @mcp-abap-adt/llm-agent`
Expected: FAIL — `Cannot find module './to-text-logger.js'`.

- [ ] **Step 4: Write the re-export**

Create `packages/llm-agent/src/logger/text-logger.ts`:

```ts
import type { ILogger as InterfacesUtilsLogger } from '@mcp-abap-adt/interfaces-utils';

/**
 * The ordinary text logger: `info`/`error`/`warn`/`debug(message, meta?)`.
 *
 * This is `@mcp-abap-adt/interfaces-utils`' `ILogger`, re-exported under a
 * second name because llm-agent's own exported `ILogger` — the event one —
 * cannot move: `IPipelineContext.logger` and `IPipelinePlugin` hand it OUT to
 * consumer plugins, so changing that name's shape would break every plugin.
 *
 * Two names for one job is the acknowledged cost of not breaking anyone in
 * this release; converging on one is a rename, and a rename is a major.
 */
export type ITextLogger = InterfacesUtilsLogger;
```

- [ ] **Step 5: Write the adapter**

Create `packages/llm-agent/src/logger/to-text-logger.ts`:

```ts
import type { ITextLogger } from './text-logger.js';
import type { ILogger, LogEvent } from './types.js';

/** Either logger a consumer may hand to an input seam. */
export type AnyLogger = ILogger | ITextLogger;

/** An event logger has `log`; a text logger does not. */
export function isTextLogger(logger: AnyLogger): logger is ITextLogger {
  return typeof (logger as ILogger).log !== 'function';
}

/** Levels per §7: only these three sets differ from `info`. */
const ERROR_EVENTS = new Set<LogEvent['type']>(['pipeline_error']);
const WARN_EVENTS = new Set<LogEvent['type']>(['warning']);
const DEBUG_EVENTS = new Set<LogEvent['type']>([
  'rag_upsert',
  'rag_query',
  'tools_selected',
]);

/**
 * Normalise whatever a consumer passed into the event logger the internals
 * already speak. An `ILogger` is returned unchanged — the existing path does
 * not move — and an `ITextLogger` is wrapped.
 *
 * The event's `type` is the message (a `warning` carries its own), and the
 * whole event travels as `meta`: a structured event fits inside `meta`, while
 * a closed union could never carry arbitrary text.
 */
export function normaliseLogger(logger: AnyLogger): ILogger {
  if (!isTextLogger(logger)) return logger;

  return {
    log(event: LogEvent): void {
      const message = event.type === 'warning' ? event.message : event.type;
      if (ERROR_EVENTS.has(event.type)) logger.error(message, event);
      else if (WARN_EVENTS.has(event.type)) logger.warn(message, event);
      else if (DEBUG_EVENTS.has(event.type)) logger.debug(message, event);
      else logger.info(message, event);
    },
  };
}
```

- [ ] **Step 6: Export all three**

In `packages/llm-agent/src/index.ts`, beside the existing logger export at :76 (`export type { ILogger, LogEvent } from './logger/types.js';`):

```ts
export type { ITextLogger } from './logger/text-logger.js';
export type { AnyLogger } from './logger/to-text-logger.js';
export { isTextLogger, normaliseLogger } from './logger/to-text-logger.js';
```

- [ ] **Step 7: Run the tests, build and lint**

Run: `npm test -w @mcp-abap-adt/llm-agent && npm run build -w @mcp-abap-adt/llm-agent && npm run lint:check`
Expected: the new tests pass, every existing test still passes, build and lint clean.

- [ ] **Step 8: Commit**

```bash
git add packages/llm-agent/package.json package-lock.json \
        packages/llm-agent/src/logger/text-logger.ts \
        packages/llm-agent/src/logger/to-text-logger.ts \
        packages/llm-agent/src/logger/to-text-logger.test.ts \
        packages/llm-agent/src/index.ts
git commit -m "feat(llm-agent): accept an ordinary text logger at the boundary

ITextLogger re-exports interfaces-utils' ILogger, and normaliseLogger turns
one into the event logger the internals speak. The exported ILogger does not
move: plugins receive it from IPipelineContext and would break."
```

---

### Task 2: The contracts-package input seams

**Files:**
- Modify: `packages/llm-agent/src/interfaces/mcp-connection-strategy.ts` (`ConnectionStrategyOptions.logger` at :76)
- Modify: `packages/llm-agent/src/resilience/embedder-resilience.ts` (`logger?: ILogger` at :67; the call site is :81)
- Create: `packages/llm-agent/src/resilience/embedder-resilience-text-logger.test.ts`

**Interfaces:**
- Consumes: `AnyLogger`, `normaliseLogger` from Task 1.
- Produces: both options typed `AnyLogger`; no change to what either passes onward.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent/src/resilience/embedder-resilience-text-logger.test.ts`. The stub below is the `BatchProvider` shape the existing `embedder-resilience.test.ts` already uses (structural typing — there is no `IEmbedder` to import). Re-composing an already-composed embedder with a *different* explicit cap is the one path in this file that emits an event, so it is what the test drives.

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult } from '../interfaces/rag.js';
import type { LogEvent } from '../logger/types.js';
import type { ITextLogger } from '../logger/text-logger.js';
import { composeResilientEmbedder } from './embedder-resilience.js';

class BatchProvider {
  readonly maxBatchSize = 250;
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    return texts.map(() => ({ vector: [0] }));
  }
}

function recordingTextLogger(): {
  logger: ITextLogger;
  calls: Array<{ level: string; message: string; meta?: unknown }>;
} {
  const calls: Array<{ level: string; message: string; meta?: unknown }> = [];
  const push = (level: string) => (message: string, meta?: unknown) => {
    calls.push({ level, message, meta });
  };
  return {
    calls,
    logger: {
      info: push('info'),
      error: push('error'),
      warn: push('warn'),
      debug: push('debug'),
    },
  };
}

describe('composeResilientEmbedder with a text logger', () => {
  it('reports the maxBatchSize conflict through an ITextLogger', () => {
    const { logger, calls } = recordingTextLogger();

    // First composition fixes the cap at the provider's own 250.
    const composed = composeResilientEmbedder(new BatchProvider());
    // Re-composing with a DIFFERENT explicit cap is the path that warns.
    composeResilientEmbedder(composed, { explicitMaxBatchSize: 99, logger });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].level, 'warn');
    // A `warning` carries its own text as the message, per §7.
    assert.match(calls[0].message, /already composed with maxBatchSize 250/);
    // ...and the whole event travels as meta.
    assert.equal((calls[0].meta as LogEvent).type, 'warning');
  });

  it('still accepts the event logger on the same path, unchanged', () => {
    const events: LogEvent[] = [];

    const composed = composeResilientEmbedder(new BatchProvider());
    composeResilientEmbedder(composed, {
      explicitMaxBatchSize: 99,
      logger: { log: (e: LogEvent) => void events.push(e) },
    });

    assert.deepEqual(
      events.map((e) => e.type),
      ['warning'],
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

**Two commands, and the type failure is NOT the test run.** `npm test` runs `node --import tsx/esm`, and tsx transpiles without type-checking — code that violates the option type still executes. So the compiler is what proves the type widened, and the test is what proves the behaviour:

Run: `npm run build -w @mcp-abap-adt/llm-agent`
Expected: FAIL — `Type 'ITextLogger' is not assignable to type 'ILogger'` (TS2322/TS2345) at the test's `logger:` property.

Run: `npm test -w @mcp-abap-adt/llm-agent`
Expected: FAIL with `TypeError: options?.logger?.log is not a function`. Note what does *not* happen: `?.` guards only the value to its left, so `options?.logger?.log(...)` still calls a property that a text logger does not have — it throws rather than silently skipping. The failure is real either way, but expect the TypeError, not a quiet `calls.length === 0`.

- [ ] **Step 3: Widen `ConnectionStrategyOptions`**

In `packages/llm-agent/src/interfaces/mcp-connection-strategy.ts`, at :76:

```ts
export interface ConnectionStrategyOptions {
  skipRevectorize?: boolean;
  /**
   * Either logger shape. An `ITextLogger` is normalised at the boundary, so
   * everything downstream keeps receiving the event `ILogger`.
   */
  logger?: AnyLogger;
  cooldownMs?: number;
}
```

Import `AnyLogger` as a type from `../logger/to-text-logger.js`.

Then, wherever this package consumes that option, normalise once at the point it is stored. The strategies live in `@mcp-abap-adt/llm-agent-mcp` (`strategies/lazy-connection-strategy.ts:32` holds `private readonly _logger?: ILogger;` and assigns it at :49): change that assignment to `this._logger = options?.logger ? normaliseLogger(options.logger) : undefined;`, importing `normaliseLogger` as a runtime import. Its `this._logger?.log({...})` call sites (e.g. :123) then need no change at all — that is the point of normalising.

- [ ] **Step 4: Widen the embedder resilience option**

In `packages/llm-agent/src/resilience/embedder-resilience.ts`, change `logger?: ILogger;` to `logger?: AnyLogger;` in `ComposeResilienceOptions` (the field is at :67).

`composeResilientEmbedder(inner, options?)` is a plain **function**, not a class, so normalise once at the top of its body — before the `getResilienceMetadata(inner)` check — and route every existing call through it:

```ts
export function composeResilientEmbedder(
  inner: IEmbedder,
  options?: ComposeResilienceOptions,
): IEmbedder {
  const log = options?.logger ? normaliseLogger(options.logger) : undefined;
  const existing = getResilienceMetadata(inner);
  // ...unchanged...
```

Then replace each `options?.logger?.log({ ... })` with `log?.log({ ... })` — there is one inside the `if (existing)` conflict branch (:81); search the file for any others and convert them the same way. Do not change a single event payload: the messages are asserted by the pre-existing `embedder-resilience.test.ts`.

Import `normaliseLogger` as a runtime import and `AnyLogger` as a type import from `../logger/to-text-logger.js`.

- [ ] **Step 5: Widen the two public RAG-factory options**

`packages/llm-agent-rag/src/rag-factories.ts` declares two more public logger inputs — `EmbedderResolutionOptions.logger` (:138, inside the interface at :132) and `RagResolutionOptions.logger` (:255, interface at :249) — and both are exported from that package's barrel (`src/index.ts:12` and `:17`). Leaving them at `ILogger` would be the exact defect §7 exists to remove: `:162` forwards `options?.logger` straight into `composeResilientEmbedder`, which this task just taught to accept both shapes, so a consumer holding a text logger would still have to write an adapter to reach a seam that already accepts one.

Change both fields to `logger?: AnyLogger`, keeping their docstrings, and importing `AnyLogger` as a type from `@mcp-abap-adt/llm-agent`.

No normalisation is needed at `:162`: it forwards the option into `composeResilientEmbedder`, whose own option is now `AnyLogger` and which normalises internally (Step 4). If any OTHER site in this file calls `.log(...)` on the option directly, normalise there with `const log = options?.logger ? normaliseLogger(options.logger) : undefined;` and call `log?.log(...)` — search the file for `logger?.log(` before you finish.

- [ ] **Step 6: Run the tests, build and lint**

Run: `npm test -w @mcp-abap-adt/llm-agent && npm test -w @mcp-abap-adt/llm-agent-mcp && npm test -w @mcp-abap-adt/llm-agent-rag && npm run build && npm run lint:check`
Expected: all pass, including every pre-existing test in all three packages, unedited. The root `npm run build` is what proves the widened options still compile for their consumers.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent/src/interfaces/mcp-connection-strategy.ts \
        packages/llm-agent/src/resilience/embedder-resilience.ts \
        packages/llm-agent/src/resilience/embedder-resilience-text-logger.test.ts \
        packages/llm-agent-mcp/src/strategies/lazy-connection-strategy.ts \
        packages/llm-agent-rag/src/rag-factories.ts
git commit -m "feat(llm-agent): connection strategies, embedder resilience and the RAG factories take either logger"
```

---

### Task 3: `withLogger` and the session factory

**Files:**
- Modify: `packages/llm-agent-libs/src/builder.ts` (`_logger` field at :176, `withLogger` at :386)
- Modify: `packages/llm-agent-libs/src/session/session-graph-factory.ts` (`SessionGraphFactoryOptions.logger` at :107)
- Create: `packages/llm-agent-libs/src/__tests__/text-logger-di.test.ts`

**Interfaces:**
- Consumes: `AnyLogger`, `normaliseLogger` from Task 1.
- Produces: `withLogger(logger: AnyLogger): this`; `SessionGraphFactoryOptions.logger?: AnyLogger`. Both store a normalised `ILogger` internally, so every downstream consumer of `this._logger` / `this.opts.logger` is untouched.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/__tests__/text-logger-di.test.ts`. It must **observe the adapter**, not merely build an agent: a test that only calls `build()` and `healthCheck()` proves nothing, because a text logger that is silently ignored passes it.

The one path that reliably emits without a network or an MCP server is startup model validation — an LLM whose `chat()` always fails produces exactly one `warning` (attempt 1, then the loop exits on `attempt < maxAttempts`) followed by one `pipeline_error`, and then `build()` rejects. The stubs mirror the existing `builder-startup-validation.test.ts`.

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  IEmbedder,
  IEmbedResult,
  ILlm,
  ITextLogger,
  LlmStreamChunk,
  LlmTool,
  LogEvent,
  Result,
} from '@mcp-abap-adt/llm-agent';

/** Always fails validation — the startup path is the one that logs. */
function failingLlm(): ILlm {
  return {
    async chat(
      _m: unknown[],
      _t?: LlmTool[],
      _o?: CallOptions,
    ): Promise<Result<{ content: string; finishReason: 'stop' }, Error>> {
      return {
        ok: false as const,
        error: new Error('deployment list unavailable') as never,
      };
    },
    async *streamChat(): AsyncGenerator<Result<LlmStreamChunk, Error>> {
      yield {
        ok: true as const,
        value: { content: 'OK', finishReason: 'stop' as const },
      };
    },
  } as ILlm;
}

function stubEmbedder(): IEmbedder {
  return {
    async embed(_text: string, _o?: CallOptions): Promise<IEmbedResult> {
      return { vector: [0.1, 0.2, 0.3] };
    },
  };
}

function recordingTextLogger(): {
  logger: ITextLogger;
  calls: Array<{ level: string; message: string; meta?: unknown }>;
} {
  const calls: Array<{ level: string; message: string; meta?: unknown }> = [];
  const push = (level: string) => (message: string, meta?: unknown) => {
    calls.push({ level, message, meta });
  };
  return {
    calls,
    logger: {
      info: push('info'),
      error: push('error'),
      warn: push('warn'),
      debug: push('debug'),
    },
  };
}

describe('SmartAgentBuilder.withLogger() — text logger', () => {
  it('routes events to a text logger at the levels §7 fixes', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const { logger, calls } = recordingTextLogger();

    await assert.rejects(
      () =>
        new SmartAgentBuilder({
          modelValidationAttempts: 2,
          modelValidationBackoffMs: 1,
        })
          .withMainLlm(failingLlm())
          .withEmbedder(stubEmbedder())
          .withLogger(logger)
          .build(),
      /Startup aborted/,
    );

    assert.deepEqual(
      calls.map((c) => c.level),
      ['warn', 'error'],
    );
    // A `warning` carries its OWN text as the message — not the string 'warning'.
    assert.match(calls[0].message, /validation attempt 1 failed/);
    // Every other kind uses the event's type as the message.
    assert.equal(calls[1].message, 'pipeline_error');
    // The whole event travels as meta.
    assert.equal((calls[1].meta as LogEvent).type, 'pipeline_error');
  });

  it('the event logger still receives the same events, unchanged', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const events: LogEvent[] = [];

    await assert.rejects(
      () =>
        new SmartAgentBuilder({
          modelValidationAttempts: 2,
          modelValidationBackoffMs: 1,
        })
          .withMainLlm(failingLlm())
          .withEmbedder(stubEmbedder())
          .withLogger({ log: (e: LogEvent) => void events.push(e) })
          .build(),
      /Startup aborted/,
    );

    assert.deepEqual(
      events.map((e) => e.type),
      ['warning', 'pipeline_error'],
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

**Two commands. The type failure comes from `tsc`; the test fails on its assertion.** `npm test` runs `node --import tsx/esm`, which transpiles without type-checking, so a `withLogger(textLogger)` call that violates the signature still runs — do not expect the test to catch the type.

Run: `npm run build -w @mcp-abap-adt/llm-agent-libs`
Expected: FAIL — `Argument of type 'ITextLogger' is not assignable to parameter of type 'ILogger'` (TS2345) at the `withLogger(logger)` call.

Run: `npm test -w @mcp-abap-adt/llm-agent-libs`
Expected: FAIL — but on `assert.rejects`, and earlier than the level assertions. `?.` guards only the value to its left, so `log?.log({...})` inside `build()` calls a property a text logger does not have and throws `TypeError: log?.log is not a function`. `build()` therefore rejects with that TypeError instead of `Startup aborted`, and `assert.rejects(..., /Startup aborted/)` fails on the message mismatch — the `calls` assertions are never reached. That is still a correct RED: the test passes only once normalisation makes the event reach the text logger. (The second test, which passes an event logger, passes already — it is the regression guard.)

- [ ] **Step 3: Widen `withLogger`, normalising at the setter**

In `packages/llm-agent-libs/src/builder.ts`, keep the private field as the event type (`private _logger?: ILogger;` at :176 — unchanged), and change the setter at :386:

```ts
  /**
   * Set a logger for internal pipeline events.
   *
   * Takes either shape: the event `ILogger`, or an ordinary `ITextLogger`
   * (`info`/`warn`/`error`/`debug`). A text logger is normalised here, at the
   * boundary, so everything downstream — `PipelineDeps.logger`, the agent, the
   * connection strategy — keeps receiving the event logger it already expects,
   * and `IPipelineContext.logger` still hands plugins the type they compile
   * against.
   */
  withLogger(logger: AnyLogger): this {
    this._logger = normaliseLogger(logger);
    return this;
  }
```

Add `AnyLogger` to the type import from `@mcp-abap-adt/llm-agent` and `normaliseLogger` as a runtime import from the same package.

Normalising in the setter is what keeps this task small: `build()` reads `const log = this._logger` (:783) and hands it on in three places — `makeConnectionStrategy` (:1070), `PipelineDeps.logger` (:1325) and the agent's deps (:1357). All three keep working untouched, and none of them may be widened: :1325 feeds `IPipelineContext.logger`, an output seam.

- [ ] **Step 4: Widen the session factory option**

In `packages/llm-agent-libs/src/session/session-graph-factory.ts`, at :107, change `readonly logger?: ILogger;` to `readonly logger?: AnyLogger;`, keeping its existing docstring.

The class currently declares its options as a readonly parameter property (`:139-140`):

```ts
export class SessionGraphFactory {
  constructor(private readonly opts: SessionGraphFactoryOptions) {}
```

That form cannot be assigned to, so normalising requires an explicit field. **The field needs its own type** — this is the part that is easy to get wrong: normalising at runtime does not narrow the declared type, so if the field stays `SessionGraphFactoryOptions` (whose `logger` is now `AnyLogger`), every existing `this.opts.logger.log(...)` inside the dispose closure stops compiling, because `ITextLogger` has no `log`. Declare the narrowed shape:

```ts
/**
 * The options as this class holds them: identical to what the caller passed,
 * except the logger is always the event `ILogger`. `AnyLogger` is accepted at
 * the constructor and normalised once; everything inside this file then keeps
 * calling `.log(...)` exactly as before.
 */
type NormalisedSessionGraphFactoryOptions = Omit<
  SessionGraphFactoryOptions,
  'logger'
> & { readonly logger?: ILogger };

export class SessionGraphFactory {
  private readonly opts: NormalisedSessionGraphFactoryOptions;

  constructor(opts: SessionGraphFactoryOptions) {
    this.opts = opts.logger
      ? { ...opts, logger: normaliseLogger(opts.logger) }
      : (opts as NormalisedSessionGraphFactoryOptions);
  }
```

The cast in the `else` branch is safe and needed: with no logger present, the two types differ only in a field that is absent.

Import `normaliseLogger` as a runtime import, and `AnyLogger` as a type import, from `@mcp-abap-adt/llm-agent`; `ILogger` is already imported in this file.

Do NOT touch `SessionAgentParts.logger` at :42 — that is `SessionRequestLogger`, a different type with a different job.

- [ ] **Step 5: Run the tests, build and lint**

Run: `npm test -w @mcp-abap-adt/llm-agent-libs && npm run build && npm run lint:check`
Expected: the two new tests pass; every pre-existing test in the package passes unedited — in particular the session teardown tests that assert on `session_close_failed` message strings.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-libs/src/builder.ts \
        packages/llm-agent-libs/src/session/session-graph-factory.ts \
        packages/llm-agent-libs/src/__tests__/text-logger-di.test.ts
git commit -m "feat(llm-agent-libs): withLogger and the session factory take either logger

Normalised at the setter, so PipelineDeps, the agent and the connection
strategy keep receiving the event logger — and plugins keep their type."
```

---

### Task 4: The server assembly, and the docs

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts` (`SessionLifecycleOptions.logger` at :72)
- Modify: `CHANGELOG.md`
- Modify: `docs/INTEGRATION.md`

**Interfaces:**
- Consumes: `AnyLogger` (Task 1), the widened `SessionGraphFactoryOptions.logger` (Task 3).
- Produces: nothing later depends on this task.

- [ ] **Step 1: Widen the lifecycle option**

In `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts`, at :72, change `logger?: ILogger;` to `logger?: AnyLogger;`, keeping its docstring. It is forwarded straight into `SessionGraphFactory`, which normalises it (Task 3), so this module needs no adapter of its own — add `AnyLogger` to the existing type import from `@mcp-abap-adt/llm-agent`.

- [ ] **Step 2: Run the package tests**

Run: `npm test -w @mcp-abap-adt/llm-agent-server-libs && npm run build`
Expected: pass, nothing edited among the pre-existing tests.

- [ ] **Step 3: CHANGELOG**

Under `## [Unreleased]`, in the existing `### Added` block:

```markdown
- **`ITextLogger`** — every seam that accepts a logger now takes an ordinary
  text logger (`info`/`warn`/`error`/`debug(message, meta?)`) as well as the
  event `ILogger`: `SmartAgentBuilder.withLogger`,
  `SessionGraphFactoryOptions.logger`, `ConnectionStrategyOptions.logger`,
  `ComposeResilienceOptions.logger`, `EmbedderResolutionOptions.logger` and
  `RagResolutionOptions.logger` in `@mcp-abap-adt/llm-agent-rag`, and
  `SessionLifecycleOptions.logger` in `@mcp-abap-adt/llm-agent-server-libs`.
  A consumer that already has a logger no longer has to write a `LogEvent`
  adapter before it can pass one. Seams that hand a logger *out* — most
  visibly `IPipelineContext.logger` — are unchanged and still give you the
  event `ILogger`.
  `normaliseLogger(logger)` and the `AnyLogger` union are exported for anyone
  wiring their own seam. A text logger receives the event's `type` as the
  message — a `warning` carries its own text — and the whole event as `meta`,
  at `error` for `pipeline_error`, `warn` for `warning`, `debug` for
  `rag_upsert`/`rag_query`/`tools_selected`, and `info` for everything else.
```

And under `### Changed`, state the residue plainly rather than letting a reader discover it:

```markdown
- **llm-agent now has two logger names**, deliberately. The exported `ILogger`
  keeps its event shape because `IPipelineContext.logger` and `IPipelinePlugin`
  hand it to consumer plugins; widening it would break every plugin. The text
  shape arrives as the separate `ITextLogger`. Converging on one name is a
  rename, and a rename is a major — so it waits for one.
```

- [ ] **Step 4: INTEGRATION.md**

Add a short section in the file's existing voice:

````markdown
## Passing your own logger

Both logger shapes are accepted at every seam that *takes* one from you:

| seam | package |
|---|---|
| `SmartAgentBuilder.withLogger` | `llm-agent-libs` |
| `SessionGraphFactoryOptions.logger` | `llm-agent-libs` |
| `ConnectionStrategyOptions.logger` | `llm-agent` |
| `ComposeResilienceOptions.logger` (embedder resilience) | `llm-agent` |
| `EmbedderResolutionOptions.logger`, `RagResolutionOptions.logger` | `llm-agent-rag` |
| `SessionLifecycleOptions.logger` | `llm-agent-server-libs` |

If you already have an ordinary text logger, pass it:

```ts
import type { ITextLogger } from '@mcp-abap-adt/llm-agent';

const handle = await new SmartAgentBuilder(cfg)
  .withMainLlm(llm)
  .withLogger(myTextLogger)   // info / warn / error / debug
  .build();
```

It is normalised at the boundary: internals keep emitting structured
`LogEvent`s, and your logger receives the event's `type` as the message (a
`warning` carries its own text) with the whole event as `meta`.

What stays event-only, deliberately: everywhere llm-agent hands a logger *to
you*. `IPipelineContext.logger` still gives your plugin the event `ILogger`, so
`logger.log({ ... })` inside a plugin keeps compiling unchanged — widening that
would break every existing plugin, which is a major, not this release.

So the rule is one-directional: what you pass in may be either shape; what you
receive is always the event shape.
````

- [ ] **Step 5: Verify and commit**

Run: `npm run lint:check && npm run build && npm test`
Expected: clean across all workspaces.

```bash
git add packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts \
        CHANGELOG.md docs/INTEGRATION.md
git commit -m "feat(llm-agent-server-libs): session lifecycle takes either logger, and docs"
```

---

## Verification of the whole workstream

Run from the repository root:

```bash
npm run build && npm test && npm run lint:check
```

Expected: every workspace builds; all tests pass; Biome reports no new warnings.

**`npm run build` is not optional here, and it is not interchangeable with `npm test`.** This workstream's whole subject is a type widening, and the test runner (`node --import tsx/esm`) transpiles without type-checking — every widened seam would "pass" its tests while failing to compile for a consumer. `tsc` is the only check that proves `ILogger | ITextLogger` is actually accepted, and equally that the frozen output seams still resolve.

The claim this workstream makes: **a consumer can now hand over the logger it already has, and nobody who passes the old one notices anything.** The proof is that no pre-existing test needed editing — if one did, the change stopped being additive; stop and report it rather than adjusting the test.

The second claim, equally important: **plugins still compile.** `packages/llm-agent/src/interfaces/pipeline-plugin.ts` must not appear in this workstream's diff at all. If it does, `IPipelineContext.logger` or `IPipelinePlugin` was widened, and that is a major, not this release.
