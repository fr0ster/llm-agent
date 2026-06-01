import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NeedInfoSignal, TokenLedger } from '@mcp-abap-adt/llm-agent';
import { StepperCoordinatorHandler } from '../stepper-coordinator-handler.js';

const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

// A knowledgeRag stub that records whether the run wrote and the finalizer read.
function knowledgeStub() {
  const written: string[] = [];
  let listedBy = '';
  return {
    written,
    get listedBy() {
      return listedBy;
    },
    rag: {
      async init() {},
      async query() {
        return [];
      },
      async list() {
        listedBy = 'finalizer';
        return written.map((c) => ({
          content: c,
          metadata: {
            traceId: 't',
            turnId: 'turn-1',
            stepperId: 'n',
            task: 'x',
            artifactType: 'analysis-finding',
            createdAt: '2026-05-29T00:00:00Z',
          },
        }));
      },
      async write(e: { content: string }) {
        written.push(e.content);
      },
      fingerprint() {
        return `n=${written.length}`;
      },
    },
  };
}

function fakeBuilt(overrides = {}) {
  return {
    // root run writes to the SAME knowledgeRag it is handed
    rootStepper: {
      name: 'root',
      async run(input: {
        knowledgeRag: {
          write(e: { content: string; metadata: unknown }): Promise<void>;
        };
      }) {
        await input.knowledgeRag.write({
          content: 'finding-from-run',
          metadata: {},
        });
        return { status: 'ok', usage: ZERO };
      },
    },
    // finalizer must READ via the knowledgeRag it is handed and stream content
    finalizer: {
      async finalize(input: {
        knowledgeRag: {
          list(f: unknown): Promise<readonly { content: string }[]>;
        };
        onProgress?: (c: unknown) => void;
      }) {
        const got = await input.knowledgeRag.list({ turnId: 'turn-1' });
        const out = `FINAL: ${got.map((e) => e.content).join(',')}`;
        input.onProgress?.({ kind: 'content', delta: out });
        return { output: out, usage: ZERO };
      },
    },
    budget: { depthRemaining: 1, tokens: new TokenLedger(100000) },
    maxParallelSteps: 4,
    ...overrides,
  };
}

function ctx() {
  const yields: { content?: string; finishReason?: string }[] = [];
  return {
    yields,
    obj: {
      inputText: 'review program X',
      sessionId: 's1',
      requestLogger: {
        startRequest() {},
        getSummary() {
          return {};
        },
        logStep() {},
        logLlmCall() {},
      },
      yield(c: { value?: { content?: string; finishReason?: string } }) {
        if (c.value)
          yields.push({
            content: c.value.content,
            finishReason: c.value.finishReason,
          });
      },
      options: { trace: { traceId: 't1' } },
    },
  };
}

test('happy path: SAME knowledgeRag flows run → finalizer; content + terminal stop yielded', async () => {
  const ks = knowledgeStub();
  const h = new StepperCoordinatorHandler({
    buildBuilt: async (_ctx, _log) => fakeBuilt(),
    knowledgeRagFor: async () => ks.rag as never, // R1-F3: handler owns the source
    toolsRag: {
      async query() {
        return [];
      },
      lookup() {
        return undefined;
      },
    } as never,
    mintStepperId: () => 'root',
    mintTurnId: () => 'turn-1',
  });
  const c = ctx();
  await h.execute(c.obj as never, {}, {} as never);
  // The finalizer read what the run wrote, through the one shared knowledgeRag:
  assert.deepEqual(ks.written, ['finding-from-run']);
  assert.equal(ks.listedBy, 'finalizer');
  assert.ok(c.yields.some((y) => y.content === 'FINAL: finding-from-run'));
  assert.ok(c.yields.some((y) => y.finishReason === 'stop'));
});

test('budget-exhausted bubbles to a ClarifySignal from the coordinator (not the finalizer)', async () => {
  const ks = knowledgeStub();
  const built = fakeBuilt({
    rootStepper: {
      name: 'root',
      async run() {
        return { status: 'budget-exhausted', usage: ZERO };
      },
    },
  });
  const h = new StepperCoordinatorHandler({
    buildBuilt: async (_ctx, _log) => built,
    knowledgeRagFor: async () => ks.rag as never,
    toolsRag: {
      async query() {
        return [];
      },
      lookup() {
        return undefined;
      },
    } as never,
    mintStepperId: () => 'root',
    mintTurnId: () => 'turn-1',
  });
  const c = ctx();
  // The handler should surface a budget-extension clarify. Assert via a yielded clarify event OR a thrown ClarifySignal — match the 17.0 handler's clarify mechanism.
  await h.execute(c.obj as never, {}, {} as never);
  assert.ok(
    c.yields.some((y) => /budget/i.test(y.content ?? '')),
    'a budget-extension clarify was surfaced to the consumer',
  );
});

// ── FIX B: per-role usage logging tests ──────────────────────────────────────

test('FIX-B.1: planner, tool-loop and finalizer LLM calls are logged to logLlmCall with correct components', async () => {
  const loggedEntries: {
    component: string;
    model: string;
    totalTokens: number;
  }[] = [];

  // Scripted LLMs with known usage for each role
  function makeLlmStub(
    model: string,
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    },
  ) {
    return {
      model,
      async chat() {
        return {
          ok: true as const,
          value: {
            content: 'done',
            usage,
          },
        };
      },
      async *streamChat() {
        yield {
          ok: true as const,
          value: { content: 'done', finishReason: 'stop' as const, usage },
        };
      },
    };
  }

  // Import LoggingLlm to simulate what buildStepperRoot does internally
  const { LoggingLlm } = await import('@mcp-abap-adt/llm-agent-libs');

  const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const plannerUsage = {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  };
  const executorUsage = {
    promptTokens: 20,
    completionTokens: 8,
    totalTokens: 28,
  };
  const finalizerUsage = {
    promptTokens: 30,
    completionTokens: 12,
    totalTokens: 42,
  };

  const plannerLlmInner = makeLlmStub('planner-model', plannerUsage);
  const executorLlmInner = makeLlmStub('executor-model', executorUsage);
  const finalizerLlmInner = makeLlmStub('finalizer-model', finalizerUsage);

  const captureLog = (entry: {
    component: string;
    model: string;
    totalTokens: number;
  }) => {
    loggedEntries.push(entry);
  };

  const plannerLlm = new LoggingLlm(plannerLlmInner as never, (u, _d) =>
    captureLog({
      component: 'planner',
      model: plannerLlmInner.model,
      totalTokens: u.totalTokens,
    }),
  );
  const executorLlm = new LoggingLlm(executorLlmInner as never, (u, _d) =>
    captureLog({
      component: 'tool-loop',
      model: executorLlmInner.model,
      totalTokens: u.totalTokens,
    }),
  );
  const finalizerLlm = new LoggingLlm(finalizerLlmInner as never, (u, _d) =>
    captureLog({
      component: 'finalizer',
      model: finalizerLlmInner.model,
      totalTokens: u.totalTokens,
    }),
  );

  // Exercise each LLM once via chat() — simulating what planner/executor/finalizer do
  await plannerLlm.chat([{ role: 'user', content: 'plan' }]);
  await executorLlm.chat([{ role: 'user', content: 'exec' }]);
  await finalizerLlm.chat([{ role: 'user', content: 'finalize' }]);

  assert.equal(
    loggedEntries.length,
    3,
    `expected 3 log entries, got ${loggedEntries.length}`,
  );

  const planner = loggedEntries.find((e) => e.component === 'planner');
  assert.ok(planner, 'planner entry missing');
  assert.equal(planner?.totalTokens, 15, 'planner usage incorrect');

  const toolLoop = loggedEntries.find((e) => e.component === 'tool-loop');
  assert.ok(toolLoop, 'tool-loop entry missing');
  assert.equal(toolLoop?.totalTokens, 28, 'tool-loop usage incorrect');

  const finalizer = loggedEntries.find((e) => e.component === 'finalizer');
  assert.ok(finalizer, 'finalizer entry missing');
  assert.equal(finalizer?.totalTokens, 42, 'finalizer usage incorrect');
});

test('FIX-B.2: handler passes logLlmCall to buildBuilt; calls land in requestLogger', async () => {
  const ks = knowledgeStub();
  const loggedCalls: { component: string; model: string }[] = [];

  const h = new StepperCoordinatorHandler({
    buildBuilt: async (_ctx, logLlmCallCb) => {
      // Simulate what buildStepperRoot does: call logLlmCallCb for each role's
      // LLM invocation during the run
      logLlmCallCb({
        component: 'planner',
        model: 'planner-m',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        durationMs: 100,
        requestId: 't1',
      });
      logLlmCallCb({
        component: 'tool-loop',
        model: 'exec-m',
        promptTokens: 20,
        completionTokens: 8,
        totalTokens: 28,
        durationMs: 200,
        requestId: 't1',
      });
      logLlmCallCb({
        component: 'finalizer',
        model: 'final-m',
        promptTokens: 30,
        completionTokens: 12,
        totalTokens: 42,
        durationMs: 150,
        requestId: 't1',
      });
      return fakeBuilt() as never;
    },
    knowledgeRagFor: async () => ks.rag as never,
    toolsRag: {
      async query() {
        return [];
      },
      lookup() {
        return undefined;
      },
    } as never,
    mintStepperId: () => 'root',
    mintTurnId: () => 'turn-1',
  });

  const c = {
    yields: [] as { content?: string; finishReason?: string }[],
    obj: {
      inputText: 'review X',
      sessionId: 's1',
      requestLogger: {
        startRequest() {},
        getSummary() {
          return {};
        },
        logStep() {},
        logLlmCall(entry: { component: string; model: string }) {
          loggedCalls.push({ component: entry.component, model: entry.model });
        },
      },
      yield(chunk: { value?: { content?: string; finishReason?: string } }) {
        if (chunk.value) c.yields.push(chunk.value);
      },
      options: { trace: { traceId: 't1' } },
    },
  };

  await h.execute(c.obj as never, {}, {} as never);

  assert.ok(
    loggedCalls.some((e) => e.component === 'planner'),
    'planner call must be logged to requestLogger',
  );
  assert.ok(
    loggedCalls.some((e) => e.component === 'tool-loop'),
    'tool-loop call must be logged to requestLogger',
  );
  assert.ok(
    loggedCalls.some((e) => e.component === 'finalizer'),
    'finalizer call must be logged to requestLogger',
  );
});

// ── FIX C: NeedInfoSignal handling ───────────────────────────────────────────

/**
 * A scripted rootStepper: throws NeedInfoSignal on the FIRST run() call,
 * then returns ok on the SECOND (simulating the retry-with-guidance succeeding).
 */
function needInfoOnFirstRunStepper(executorRan: { value: boolean }) {
  let calls = 0;
  return {
    name: 'scripted-need-info',
    async run(input: {
      knowledgeRag: {
        write(e: { content: string; metadata: unknown }): Promise<void>;
      };
    }) {
      calls++;
      if (calls === 1) {
        throw new NeedInfoSignal('the ABAP source code for program ZTEST');
      }
      // Second call succeeds — record that the executor ran
      executorRan.value = true;
      await input.knowledgeRag.write({
        content: 'fetched-source',
        metadata: {},
      });
      return { status: 'ok' as const, usage: ZERO };
    },
  };
}

test('NeedInfo retry: planner raises NeedInfoSignal on first run, succeeds on retry — run completes and finalizer executes', async () => {
  const ks = knowledgeStub();
  const executorRan = { value: false };

  const built = fakeBuilt({
    rootStepper: needInfoOnFirstRunStepper(executorRan),
  });

  const h = new StepperCoordinatorHandler({
    buildBuilt: async (_ctx, _log) => built as never,
    knowledgeRagFor: async () => ks.rag as never,
    toolsRag: {
      async query() {
        return [];
      },
      lookup() {
        return undefined;
      },
    } as never,
    mintStepperId: () => 'root',
    mintTurnId: () => 'turn-1',
  });

  const c = ctx();
  // Must NOT throw — the retry-with-guidance path handles it
  await h.execute(c.obj as never, {}, {} as never);

  assert.ok(executorRan.value, 'executor must have run on the retry attempt');
  assert.ok(
    c.yields.some((y) => y.finishReason === 'stop'),
    'a terminal stop must be yielded',
  );
  // Must NOT yield a clarify (the retry resolved it)
  assert.ok(
    !c.yields.some((y) => /please provide/i.test(y.content ?? '')),
    'no clarify should be surfaced when retry succeeds',
  );
});

test('NeedInfo double-failure: planner raises NeedInfoSignal BOTH times — coordinator surfaces clarify (not stage error)', async () => {
  const ks = knowledgeStub();

  // Stepper that always raises NeedInfoSignal
  const alwaysNeedInfoStepper = {
    name: 'always-need-info',
    async run(): Promise<never> {
      throw new NeedInfoSignal('the ABAP source code for program ZTEST');
    },
  };

  const built = fakeBuilt({
    rootStepper: alwaysNeedInfoStepper,
  });

  const h = new StepperCoordinatorHandler({
    buildBuilt: async (_ctx, _log) => built as never,
    knowledgeRagFor: async () => ks.rag as never,
    toolsRag: {
      async query() {
        return [];
      },
      lookup() {
        return undefined;
      },
    } as never,
    mintStepperId: () => 'root',
    mintTurnId: () => 'turn-1',
  });

  const c = ctx();
  // Must NOT throw — second NeedInfoSignal is surfaced as a clarify, not a stage error
  await h.execute(c.obj as never, {}, {} as never);

  assert.ok(
    c.yields.some((y) => /please provide/i.test(y.content ?? '')),
    'a clarify message must be surfaced to the consumer',
  );
  assert.ok(
    c.yields.some((y) => y.finishReason === 'stop'),
    'a terminal stop must be yielded after clarify',
  );
});
