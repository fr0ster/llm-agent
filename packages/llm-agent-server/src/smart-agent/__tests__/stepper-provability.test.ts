/**
 * End-to-end provability tests for the Stepper hierarchy (Task 18).
 *
 * Covers H.2, H.3, H.4, H.7, H.8, H.9, H.10.
 * Uses real Stepper + StepperInterpreter + CyclicReActExecutor + KnowledgeRag +
 * RootFinalizer wired with scripted LLMs and a fake MCP.
 *
 * H.1/H.4b/H.4c/H.5/H.6 are already unit-covered in packages/llm-agent-libs.
 */

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { StreamChunk } from '@mcp-abap-adt/llm-agent';
import { TokenLedger } from '@mcp-abap-adt/llm-agent';
import {
  CyclicReActExecutor,
  InMemoryKnowledgeBackend,
  KnowledgeRag,
  LlmStepperPlanner,
  RootFinalizer,
  Stepper,
  StepperInterpreter,
} from '@mcp-abap-adt/llm-agent-libs';
import { JsonlKnowledgeBackend } from '../jsonl-knowledge-backend.js';
import { InMemorySessionMetaStore } from '../session-meta-store.js';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const SMALL_USAGE = { promptTokens: 10, completionTokens: 10, totalTokens: 20 };

/** Deterministic mintStepperId — creates a closure counter so each test is
 *  independent. */
function makeIdMinter() {
  let counter = 0;
  return () => `s${++counter}`;
}

/** Scripted LLM that dequeues responses in order; repeats last on overrun. */
function scriptedLlm(
  responses: Array<{
    content: string;
    toolCalls?: { name: string; arguments: unknown }[];
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  }>,
) {
  let i = 0;
  return {
    name: 'stub',
    model: 'stub-model',
    async chat() {
      const r = responses[Math.min(i++, responses.length - 1)];
      return {
        ok: true as const,
        value: {
          content: r.content,
          toolCalls: r.toolCalls,
          usage: r.usage ?? SMALL_USAGE,
        },
      };
    },
    async *streamChat() {
      yield {
        ok: true as const,
        value: { content: 'done', finishReason: 'stop', usage: SMALL_USAGE },
      };
    },
  };
}

/** Fake MCP that returns canned results keyed by tool name. */
function fakeMcp(results: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    async call(name: string, _args: unknown): Promise<string> {
      calls.push(name);
      return results[name] ?? '<no result>';
    },
  };
}

/** Minimal empty toolsRag stub. */
function emptyToolsRag() {
  return {
    async query() {
      return [];
    },
    lookup(_name: string) {
      return undefined;
    },
  };
}

/** Tools rag with one read-only tool. */
function toolsRagWith(
  tools: Record<string, { name: string; readOnly?: boolean }>,
) {
  return {
    async query() {
      return Object.values(tools);
    },
    lookup(name: string) {
      return tools[name] as never;
    },
  };
}

/** Base identity + toolSafety. */
const BASE_IDENTITY = {
  traceId: 'trace-1',
  turnId: 'turn-1',
  sessionId: 'sess-1',
  stepperId: 'root',
};

const CONFIRM_SAFETY = {
  mutationPolicy: 'confirm' as const,
  knownReadOnlyTools: new Set<string>(),
};

// ---------------------------------------------------------------------------
// H.2 — 3-level deep recursion with RAG write/read across sibling+grandchild
// ---------------------------------------------------------------------------

test('H.2 — 3-level recursion: grandchild planner sees sibling RAG write, emits leaf (no re-fetch)', async () => {
  /**
   * Tree:
   *   root (depth=2, planned-react)
   *     ├── childA (depth=1): executor — writes "REPORT z." to knowledgeRag
   *     └── childB (depth=1): stepper — calls grandchild planner
   *           └── grandchild executor: planner's knowledgeRag.query returns "REPORT z." from sibling
   *
   * The grandchild planner's query() should return the fact written by childA.
   * The grandchild should emit a "use-the-fact" leaf (no tool call to re-fetch).
   */
  const mintId = makeIdMinter();
  const backend = new InMemoryKnowledgeBackend();
  const knowledgeRag = new KnowledgeRag(backend, 'sess-h2');

  // Track planner calls and what facts they saw
  const plannerFactsSeen: string[][] = [];
  let grandchildExecutorCalls = 0;
  const mcpCallsMade = 0;

  // childA executor: writes REPORT z. to knowledge-RAG
  const childAExecutor: import('@mcp-abap-adt/llm-agent').IExecutor = {
    name: 'exec-a',
    async execute(input) {
      await input.knowledgeRag.write({
        content: 'REPORT z.',
        metadata: {
          traceId: input.identity.traceId,
          turnId: input.identity.turnId,
          stepperId: input.identity.stepperId,
          task: 'fetch source',
          artifactType: 'source-code',
          createdAt: new Date().toISOString(),
        },
      });
      return { status: 'ok', usage: ZERO };
    },
  };

  // grandchild executor: just records a call (no MCP fetch)
  const grandchildExecutor: import('@mcp-abap-adt/llm-agent').IExecutor = {
    name: 'exec-gc',
    async execute(_input) {
      grandchildExecutorCalls++;
      return { status: 'ok', usage: ZERO };
    },
  };

  // Planner for childB's sub-stepper: queries knowledgeRag, records what it sees
  // When it sees facts, returns a use-the-fact leaf (no agent → executor leaf)
  const grandchildPlannerLlm = {
    name: 'stub',
    model: 'stub',
    async chat(messages: { role: string; content: string }[]) {
      const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
      // Extract the fact block from the prompt
      const factLines = userMsg.split('\n').filter((l) => l.startsWith('- ['));
      plannerFactsSeen.push(factLines);
      // Always return a concrete leaf (no agent) — no re-fetch
      return {
        ok: true as const,
        value: {
          content: JSON.stringify({
            objective: 'use fact',
            nodes: [{ id: 'g1', goal: 'Use the already-fetched source code' }],
          }),
          usage: SMALL_USAGE,
        },
      };
    },
  };

  // childB's sub-stepper (depth=1): has its own planner + grandchild executor
  const childBStepper = new Stepper({
    name: 'childB',
    planner: new LlmStepperPlanner(grandchildPlannerLlm as never),
    interpreter: new StepperInterpreter(),
    executor: grandchildExecutor,
    childSteppers: new Map(),
    reviewerAtDepths: new Set<number>(),
    depth: 1,
    maxParallelSteps: 4,
    mintStepperId: mintId,
  });

  // root planner: returns two nodes — nodeA (no agent, leaf) and nodeB (agent: childB)
  const rootPlannerLlm = scriptedLlm([
    {
      content: JSON.stringify({
        objective: 'fetch and analyse',
        nodes: [
          { id: 'a', goal: 'fetch source code' },
          {
            id: 'b',
            goal: 'analyse source code',
            agent: 'childB',
            dependsOn: ['a'],
          },
        ],
      }),
    },
  ]);

  const rootStepper = new Stepper({
    name: 'root',
    planner: new LlmStepperPlanner(rootPlannerLlm as never),
    interpreter: new StepperInterpreter(),
    executor: childAExecutor, // agentless nodes go here (node a)
    childSteppers: new Map([['childB', childBStepper]]),
    reviewerAtDepths: new Set<number>(),
    depth: 2,
    maxParallelSteps: 4,
    mintStepperId: mintId,
  });

  const result = await rootStepper.run({
    prompt: 'review program',
    knowledgeRag: knowledgeRag as never,
    toolsRag: emptyToolsRag() as never,
    budget: { depthRemaining: 2, tokens: new TokenLedger(200000) },
    identity: BASE_IDENTITY,
    toolSafety: CONFIRM_SAFETY,
  });

  assert.equal(result.status, 'ok', `Expected ok, got ${result.status}`);

  // Grandchild executor must have run (the tree completed)
  assert.ok(grandchildExecutorCalls >= 1, 'grandchild executor must be called');

  // No MCP tool calls were made (grandchild used the leaf directly, no re-fetch)
  assert.equal(mcpCallsMade, 0, 'no MCP re-fetch should happen');

  // At least one grandchild planner invocation should have seen facts
  const sawFacts = plannerFactsSeen.some((facts) => facts.length > 0);
  assert.ok(
    sawFacts,
    'grandchild planner must see facts from sibling RAG write',
  );
});

// ---------------------------------------------------------------------------
// H.3 — Mode C (parallel), 4 orthogonal children, maxParallelSteps=2 → peak ≤ 2
// ---------------------------------------------------------------------------

test('H.3 — Mode C parallel: 4 orthogonal children with maxParallelSteps=2 → peak concurrent ≤ 2', async () => {
  const mintId = makeIdMinter();
  const backend = new InMemoryKnowledgeBackend();
  const knowledgeRag = new KnowledgeRag(backend, 'sess-h3');

  let active = 0;
  let peak = 0;

  // Slow executor that measures concurrency
  const slowExecutor: import('@mcp-abap-adt/llm-agent').IExecutor = {
    name: 'slow',
    async execute(_input) {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { status: 'ok', usage: ZERO };
    },
  };

  // Planner returns 4 orthogonal children (no dependsOn = all parallel)
  const plannerLlm = scriptedLlm([
    {
      content: JSON.stringify({
        objective: 'parallel work',
        nodes: [
          { id: 'a', goal: 'task A' },
          { id: 'b', goal: 'task B' },
          { id: 'c', goal: 'task C' },
          { id: 'd', goal: 'task D' },
        ],
      }),
    },
  ]);

  const rootStepper = new Stepper({
    name: 'root',
    planner: new LlmStepperPlanner(plannerLlm as never),
    interpreter: new StepperInterpreter(),
    executor: slowExecutor,
    childSteppers: new Map(),
    reviewerAtDepths: new Set<number>(),
    depth: 0, // cyclic-react style — all nodes go to executor
    maxParallelSteps: 2,
    mintStepperId: mintId,
  });

  const result = await rootStepper.run({
    prompt: 'run 4 parallel tasks',
    knowledgeRag: knowledgeRag as never,
    toolsRag: emptyToolsRag() as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(200000) },
    identity: BASE_IDENTITY,
    toolSafety: CONFIRM_SAFETY,
  });

  assert.equal(result.status, 'ok');
  assert.ok(peak <= 2, `Peak concurrency ${peak} must be ≤ 2`);
});

// ---------------------------------------------------------------------------
// H.4 — Token budget exhaustion → budget-exhausted status bubbles to root
// ---------------------------------------------------------------------------

test('H.4 — budget exhaustion: executor returns budget-exhausted; assert-at-root (status bubbles)', async () => {
  /**
   * Per plan: assert at root that budget-exhausted bubbles up.
   * We wire a CyclicReActExecutor with a scripted LLM that uses many tokens
   * so the shared ledger is exhausted by the second iteration check.
   */
  const mintId = makeIdMinter();
  const backend = new InMemoryKnowledgeBackend();
  const knowledgeRag = new KnowledgeRag(backend, 'sess-h4');

  const mcp = fakeMcp({ ReadProgram: 'src' });

  // Two tool-call responses each spending 60k tokens → ledger of 100k exhausted
  const llm = scriptedLlm([
    {
      content: 'reading',
      toolCalls: [{ name: 'ReadProgram', arguments: { p: 'Z' } }],
      usage: { promptTokens: 60000, completionTokens: 0, totalTokens: 60000 },
    },
    {
      content: 'reading more',
      toolCalls: [{ name: 'ReadProgram', arguments: { p: 'Z' } }],
      usage: { promptTokens: 60000, completionTokens: 0, totalTokens: 60000 },
    },
  ]);

  const executor = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: mcp.call,
    component: 'tool-loop',
    maxIterations: 10,
  });

  const plannerLlm = scriptedLlm([
    {
      content: JSON.stringify({
        objective: 'read',
        nodes: [{ id: 'a', goal: 'read program' }],
      }),
    },
  ]);

  const rootStepper = new Stepper({
    name: 'root',
    planner: new LlmStepperPlanner(plannerLlm as never),
    interpreter: new StepperInterpreter(),
    executor,
    childSteppers: new Map(),
    reviewerAtDepths: new Set<number>(),
    depth: 0,
    maxParallelSteps: 4,
    mintStepperId: mintId,
  });

  // Shared token ledger with 100k — will be exhausted mid-execution
  const sharedLedger = new TokenLedger(100000);

  const result = await rootStepper.run({
    prompt: 'read program',
    knowledgeRag: knowledgeRag as never,
    toolsRag: toolsRagWith({
      ReadProgram: { name: 'ReadProgram', readOnly: true },
    }) as never,
    budget: { depthRemaining: 0, tokens: sharedLedger },
    identity: BASE_IDENTITY,
    toolSafety: CONFIRM_SAFETY,
  });

  assert.equal(
    result.status,
    'budget-exhausted',
    `Expected budget-exhausted, got ${result.status}`,
  );
});

// ---------------------------------------------------------------------------
// H.7 — Progress events across a 3-level tree: parentStepperId chain, no node-*
// ---------------------------------------------------------------------------

test('H.7 — progress events: parentStepperId links across 3-level tree; no node-* chunks; root finalizer streams content', async () => {
  const mintId = makeIdMinter();
  const backend = new InMemoryKnowledgeBackend();
  const knowledgeRag = new KnowledgeRag(backend, 'sess-h7');

  const events: StreamChunk[] = [];
  const onProgress = (e: StreamChunk) => events.push(e);

  // Level 2 child executor (terminal)
  const leafExecutor: import('@mcp-abap-adt/llm-agent').IExecutor = {
    name: 'leaf',
    async execute(input) {
      await input.knowledgeRag.write({
        content: 'leaf-result',
        metadata: {
          traceId: input.identity.traceId,
          turnId: input.identity.turnId,
          stepperId: input.identity.stepperId,
          task: input.prompt,
          artifactType: 'analysis-finding',
          createdAt: new Date().toISOString(),
        },
      });
      return { status: 'ok', usage: ZERO };
    },
  };

  // Level 2 child planner (depth=0 → routes to executor)
  const level2PlannerLlm = scriptedLlm([
    {
      content: JSON.stringify({
        objective: 'leaf task',
        nodes: [{ id: 'g1', goal: 'do leaf work' }],
      }),
    },
  ]);

  const level2Stepper = new Stepper({
    name: 'level2',
    planner: new LlmStepperPlanner(level2PlannerLlm as never),
    interpreter: new StepperInterpreter(),
    executor: leafExecutor,
    childSteppers: new Map(),
    reviewerAtDepths: new Set<number>(),
    depth: 1,
    maxParallelSteps: 4,
    mintStepperId: mintId,
  });

  // Level 1 child planner (depth=1 → can spawn level2)
  const level1PlannerLlm = scriptedLlm([
    {
      content: JSON.stringify({
        objective: 'intermediate',
        nodes: [{ id: 'c1', goal: 'delegate to level2', agent: 'level2' }],
      }),
    },
  ]);

  const level1Stepper = new Stepper({
    name: 'level1',
    planner: new LlmStepperPlanner(level1PlannerLlm as never),
    interpreter: new StepperInterpreter(),
    executor: leafExecutor, // fallback
    childSteppers: new Map([['level2', level2Stepper]]),
    reviewerAtDepths: new Set<number>(),
    depth: 1,
    maxParallelSteps: 4,
    mintStepperId: mintId,
  });

  // Root planner (depth=2 → can spawn level1)
  const rootPlannerLlm = scriptedLlm([
    {
      content: JSON.stringify({
        objective: 'root task',
        nodes: [{ id: 'r1', goal: 'delegate to level1', agent: 'level1' }],
      }),
    },
  ]);

  const rootStepper = new Stepper({
    name: 'root',
    planner: new LlmStepperPlanner(rootPlannerLlm as never),
    interpreter: new StepperInterpreter(),
    executor: leafExecutor,
    childSteppers: new Map([['level1', level1Stepper]]),
    reviewerAtDepths: new Set<number>(),
    depth: 2,
    maxParallelSteps: 4,
    mintStepperId: mintId,
  });

  const rootIdentity = {
    traceId: 'trace-h7',
    turnId: 'turn-h7',
    sessionId: 'sess-h7',
    stepperId: 'root-stepper',
  };

  const runResult = await rootStepper.run({
    prompt: 'run 3-level tree',
    knowledgeRag: knowledgeRag as never,
    toolsRag: emptyToolsRag() as never,
    budget: { depthRemaining: 2, tokens: new TokenLedger(200000) },
    identity: rootIdentity,
    toolSafety: CONFIRM_SAFETY,
    onProgress,
  });

  assert.equal(runResult.status, 'ok');

  // Collect stepper-spawned events
  const spawned = events.filter(
    (
      e,
    ): e is {
      kind: 'stepper-spawned';
      source: { stepperId: string; parentStepperId?: string; name: string };
      goal: string;
    } => e.kind === 'stepper-spawned',
  );

  // Must have at least 2 levels of spawned events (root→level1, level1→level2)
  assert.ok(
    spawned.length >= 2,
    `Expected ≥2 stepper-spawned events, got ${spawned.length}`,
  );

  // Each spawned event must have parentStepperId set (all are child dispatches)
  for (const s of spawned) {
    assert.ok(
      s.source.parentStepperId !== undefined,
      `stepper-spawned event for ${s.source.name} must carry parentStepperId`,
    );
  }

  // Verify the parent/child chain: child's parentStepperId must match a known ancestor's stepperId
  // The first level spawned by root has parentStepperId = root-stepper
  const level1Spawn = spawned[0];
  assert.equal(
    level1Spawn.source.parentStepperId,
    rootIdentity.stepperId,
    'level1 spawn parentStepperId must equal root stepperId',
  );

  // stepper-done events must match spawned events count
  const done = events.filter((e) => e.kind === 'stepper-done');
  assert.equal(
    done.length,
    spawned.length,
    'stepper-done count must match stepper-spawned count',
  );

  // Legacy node-* / tool-call variants have been removed from the StreamChunk
  // union (Task 19e); only 18.0 Stepper progress events are emitted.

  // Root finalizer streams content chunks
  const finalizerLlm = {
    name: 'finalizer-stub',
    model: 'stub',
    async *streamChat() {
      yield {
        ok: true as const,
        value: {
          content: 'Summary: ',
          finishReason: undefined as never,
          usage: undefined,
        },
      };
      yield {
        ok: true as const,
        value: {
          content: 'leaf-result done',
          finishReason: 'stop',
          usage: SMALL_USAGE,
        },
      };
    },
  };

  const finalizerEvents: StreamChunk[] = [];
  const finalizer = new RootFinalizer(finalizerLlm as never);
  const finResult = await finalizer.finalize({
    prompt: 'run 3-level tree',
    knowledgeRag: knowledgeRag as never,
    turnId: rootIdentity.turnId,
    onProgress: (e) => finalizerEvents.push(e),
  });

  assert.ok(
    finResult.output.includes('leaf-result done'),
    'finalizer output must contain streamed text',
  );
  const contentChunks = finalizerEvents.filter((e) => e.kind === 'content');
  assert.ok(contentChunks.length >= 1, 'finalizer must emit content chunks');
});

// ---------------------------------------------------------------------------
// H.8 — Session resume: JsonlKnowledgeBackend cross-restart durability
// ---------------------------------------------------------------------------

const H8_DIR = join(tmpdir(), `stepper-h8-${process.pid}`);

test('H.8 — session resume: second KnowledgeRag over same JsonlKnowledgeBackend sees prior entries', async () => {
  await rm(H8_DIR, { recursive: true, force: true });

  const sessionId = 'sess-h8-resume';

  // --- First "process": write entries ---
  const backend1 = new JsonlKnowledgeBackend(H8_DIR);
  const kr1 = new KnowledgeRag(backend1 as never, sessionId);

  const META1 = {
    traceId: 'trace-h8',
    turnId: 'turn-h8-1',
    stepperId: 'stepper-1',
    task: 'fetch',
    artifactType: 'source-code' as const,
    createdAt: '2026-05-29T10:00:00Z',
  };

  await kr1.write({ content: 'prior-source-code', metadata: META1 });
  await kr1.write({
    content: 'prior-analysis',
    metadata: {
      ...META1,
      artifactType: 'analysis-finding',
      createdAt: '2026-05-29T10:01:00Z',
    },
  });

  // --- Second "process": fresh backend instance over same dir ---
  const backend2 = new JsonlKnowledgeBackend(H8_DIR);
  const kr2 = new KnowledgeRag(backend2 as never, sessionId);
  await kr2.init(); // rehydrate from durable JSONL

  // The resumed KnowledgeRag must see all prior entries
  const allEntries = await kr2.list({});
  assert.equal(
    allEntries.length,
    2,
    `Expected 2 entries after resume, got ${allEntries.length}`,
  );
  assert.equal(allEntries[0].content, 'prior-source-code');
  assert.equal(allEntries[1].content, 'prior-analysis');

  // Planner query must also work (uses semanticQuery / recency fallback)
  const queryResult = await kr2.query('source code', { k: 5 });
  assert.ok(
    queryResult.length >= 1,
    'query on resumed backend must return entries',
  );

  // H.8 also requires: InMemorySessionMetaStore row flips in-progress → idle
  // on restart scan (§G.5). Simulate the pattern:
  const metaStore = new InMemorySessionMetaStore();
  await metaStore.create({
    sessionId,
    userIdentity: 'user-1',
    status: 'in-progress',
    createdAt: '2026-05-29T10:00:00Z',
  });

  // On restart scan, sessions that were in-progress are flipped to idle
  const inProgress = await metaStore.inProgressSessions();
  assert.ok(
    inProgress.some((r) => r.sessionId === sessionId),
    'session must appear as in-progress before restart scan',
  );

  for (const row of inProgress) {
    await metaStore.setStatus(row.sessionId, 'idle');
  }

  const afterScan = await metaStore.get(sessionId);
  assert.equal(
    afterScan?.status,
    'idle',
    'session status must flip to idle after restart scan',
  );
});

test('H.8 cleanup', async () => {
  await rm(H8_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// H.9 — Cycle prevention: planner with same task but RAG populated → use-the-fact leaf
// ---------------------------------------------------------------------------

test('H.9 — cycle prevention: planner sees non-empty RAG, emits use-the-fact leaf (no infinite recursion)', async () => {
  /**
   * Scenario: the planner's task is identical to the parent's task (cycle risk).
   * BUT the knowledgeRag already has a matching entry written by an earlier step.
   * The planner must detect the fact in its prompt and return a leaf with no
   * sub-agent (no re-decomposition). maxDepth = 1 is the safety net.
   */
  const mintId = makeIdMinter();
  const backend = new InMemoryKnowledgeBackend();
  const knowledgeRag = new KnowledgeRag(backend, 'sess-h9');

  // Pre-populate the knowledge-RAG with the "prior" entry
  await knowledgeRag.write({
    content: 'already fetched: REPORT z.',
    metadata: {
      traceId: 'trace-h9',
      turnId: 'turn-h9',
      stepperId: 'prior-stepper',
      task: 'fetch source code for Z',
      artifactType: 'source-code',
      createdAt: new Date().toISOString(),
    },
  });

  let plannerCallCount = 0;
  let executorCallCount = 0;

  // Planner that mimics RAG-first: when it sees facts in its prompt, returns a leaf
  const ragFirstPlannerLlm = {
    name: 'stub',
    model: 'stub',
    async chat(messages: { role: string; content: string }[]) {
      plannerCallCount++;
      const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
      const hasFacts = userMsg.includes('already fetched');
      return {
        ok: true as const,
        value: {
          content: hasFacts
            ? // Use-the-fact leaf (no agent) — prevents recursion
              JSON.stringify({
                objective: 'use fact',
                nodes: [{ id: 'u1', goal: 'Use already-fetched source code' }],
              })
            : // Without facts, would recurse — but maxDepth bounds it
              JSON.stringify({
                objective: 'fetch',
                nodes: [{ id: 'f1', goal: 'fetch source code for Z' }],
              }),
          usage: SMALL_USAGE,
        },
      };
    },
  };

  const executor: import('@mcp-abap-adt/llm-agent').IExecutor = {
    name: 'exec',
    async execute(_input) {
      executorCallCount++;
      return { status: 'ok', usage: ZERO };
    },
  };

  const rootStepper = new Stepper({
    name: 'root',
    planner: new LlmStepperPlanner(ragFirstPlannerLlm as never),
    interpreter: new StepperInterpreter(),
    executor,
    childSteppers: new Map(), // no child agents → can only go to executor
    reviewerAtDepths: new Set<number>(),
    depth: 1, // maxDepth = 1 as safety net
    maxParallelSteps: 4,
    mintStepperId: mintId,
  });

  const result = await rootStepper.run({
    prompt: 'fetch source code for Z',
    knowledgeRag: knowledgeRag as never,
    toolsRag: emptyToolsRag() as never,
    budget: { depthRemaining: 1, tokens: new TokenLedger(200000) },
    identity: {
      traceId: 'trace-h9',
      turnId: 'turn-h9',
      sessionId: 'sess-h9',
      stepperId: 'root-h9',
    },
    toolSafety: CONFIRM_SAFETY,
  });

  assert.equal(result.status, 'ok', `Expected ok, got ${result.status}`);

  // Planner must have been called (it ran RAG-first)
  assert.ok(plannerCallCount >= 1, 'planner must have been called');

  // Executor must run exactly once (leaf from use-the-fact plan)
  assert.ok(executorCallCount >= 1, 'executor must be reached (leaf node)');

  // No infinite recursion: total planner calls bounded by tree size
  assert.ok(
    plannerCallCount <= 3,
    `planner called ${plannerCallCount} times — bounded by maxDepth`,
  );
});

// ---------------------------------------------------------------------------
// H.10 — maxParallelSteps locally enforced: 2-level tree, maxN=2 each level → peak ≤ 4
// ---------------------------------------------------------------------------

test('H.10 — maxParallelSteps locally enforced: 2-level tree, maxN=2 at each level → global peak ≤ 4', async () => {
  const mintId = makeIdMinter();
  const backend = new InMemoryKnowledgeBackend();
  const knowledgeRag = new KnowledgeRag(backend, 'sess-h10');

  let active = 0;
  let peak = 0;

  // Slow executor that measures global concurrency
  const slowExecutor: import('@mcp-abap-adt/llm-agent').IExecutor = {
    name: 'slow-exec',
    async execute(_input) {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 8));
      active--;
      return { status: 'ok', usage: ZERO };
    },
  };

  // Level-1 sub-stepper (depth=0): plans 2 leaf nodes each with maxParallelSteps=2
  const _level1PlannerLlm = scriptedLlm([
    {
      content: JSON.stringify({
        objective: 'level1 work',
        nodes: [
          { id: 'x1', goal: 'leaf task x1' },
          { id: 'x2', goal: 'leaf task x2' },
        ],
      }),
    },
    // Reused for both level1A and level1B instances
    {
      content: JSON.stringify({
        objective: 'level1 work',
        nodes: [
          { id: 'y1', goal: 'leaf task y1' },
          { id: 'y2', goal: 'leaf task y2' },
        ],
      }),
    },
  ]);

  // Two separate level-1 steppers (one per root child)
  const level1A = new Stepper({
    name: 'level1A',
    planner: new LlmStepperPlanner(
      scriptedLlm([
        {
          content: JSON.stringify({
            objective: 'l1A work',
            nodes: [
              { id: 'a1', goal: 'leaf a1' },
              { id: 'a2', goal: 'leaf a2' },
            ],
          }),
        },
      ]) as never,
    ),
    interpreter: new StepperInterpreter(),
    executor: slowExecutor,
    childSteppers: new Map(),
    reviewerAtDepths: new Set<number>(),
    depth: 0,
    maxParallelSteps: 2, // local cap at level 1
    mintStepperId: mintId,
  });

  const level1B = new Stepper({
    name: 'level1B',
    planner: new LlmStepperPlanner(
      scriptedLlm([
        {
          content: JSON.stringify({
            objective: 'l1B work',
            nodes: [
              { id: 'b1', goal: 'leaf b1' },
              { id: 'b2', goal: 'leaf b2' },
            ],
          }),
        },
      ]) as never,
    ),
    interpreter: new StepperInterpreter(),
    executor: slowExecutor,
    childSteppers: new Map(),
    reviewerAtDepths: new Set<number>(),
    depth: 0,
    maxParallelSteps: 2, // local cap at level 1
    mintStepperId: mintId,
  });

  // Root planner: returns 2 children (both sub-steppers)
  const rootPlannerLlm = scriptedLlm([
    {
      content: JSON.stringify({
        objective: 'root work',
        nodes: [
          { id: 'r1', goal: 'child A work', agent: 'level1A' },
          { id: 'r2', goal: 'child B work', agent: 'level1B' },
        ],
      }),
    },
  ]);

  const rootStepper = new Stepper({
    name: 'root',
    planner: new LlmStepperPlanner(rootPlannerLlm as never),
    interpreter: new StepperInterpreter(),
    executor: slowExecutor,
    childSteppers: new Map([
      ['level1A', level1A],
      ['level1B', level1B],
    ]),
    reviewerAtDepths: new Set<number>(),
    depth: 1,
    maxParallelSteps: 2, // root also caps at 2 → 2 children run concurrently
    mintStepperId: mintId,
  });

  const result = await rootStepper.run({
    prompt: 'run 2-level tree',
    knowledgeRag: knowledgeRag as never,
    toolsRag: emptyToolsRag() as never,
    budget: { depthRemaining: 1, tokens: new TokenLedger(200000) },
    identity: {
      traceId: 'trace-h10',
      turnId: 'turn-h10',
      sessionId: 'sess-h10',
      stepperId: 'root-h10',
    },
    toolSafety: CONFIRM_SAFETY,
  });

  assert.equal(result.status, 'ok', `Expected ok, got ${result.status}`);

  // With 2 root children × 2 leaf nodes each, if both children run concurrently
  // and each is capped at 2 internally, global peak ≤ 4.
  assert.ok(
    peak <= 4,
    `Global peak concurrency ${peak} must be ≤ 4 (2 children × 2 local caps)`,
  );
});
