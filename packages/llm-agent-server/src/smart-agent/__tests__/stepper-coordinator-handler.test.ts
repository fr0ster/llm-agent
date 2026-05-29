import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenLedger } from '@mcp-abap-adt/llm-agent';
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
    toolSafety: { mutationPolicy: 'confirm', knownReadOnlyTools: new Set() },
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
    buildBuilt: async () => fakeBuilt(),
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
    buildBuilt: async () => built,
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
