/**
 * #213 diagnostics: the controller must emit, under DEBUG_CONTROLLER, one
 * `classify` line per request (fires on EVERY branch, incl. early returns) and a
 * `run` line once the run identity is settled. Regression guard: on a fresh run
 * the runId is minted AFTER classify, so a single line logged at classify time
 * would report `run=undefined` — exactly the case being diagnosed.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type {
  IKnowledgeRagHandle,
  LlmStreamChunk,
  Result,
} from '@mcp-abap-adt/llm-agent';
import type { PipelineContext } from '@mcp-abap-adt/llm-agent-libs';
import {
  InMemoryKnowledgeBackend,
  SessionRequestLogger,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  ControllerCoordinatorHandler,
  type ControllerHandlerDeps,
} from '../controller-coordinator-handler.js';
import type { ISubagentClient } from '../subagent-client.js';
import type { ControllerConfig, SubagentResult } from '../types.js';

type Captured = Result<LlmStreamChunk, unknown>;

let lines: string[] = [];
const realErr = console.error;

beforeEach(() => {
  lines = [];
  process.env.DEBUG_CONTROLLER = '1';
  console.error = (msg?: unknown) => {
    lines.push(String(msg));
  };
});

afterEach(() => {
  console.error = realErr;
  // NOTE: assigning `undefined` to a process.env value stringifies it to the
  // string "undefined" (still truthy) — must `delete` to actually unset it.
  delete process.env.DEBUG_CONTROLLER;
});

// ---------------------------------------------------------------------------
// Helpers — mirrored from controller-mcp-failloud.test.ts (scriptedClient,
// stubRag) and usage-e2e.test.ts (planner short-circuits straight to `done`,
// no plan/executor round-trip needed to finish the run).
// ---------------------------------------------------------------------------

function scriptedClient(queue: SubagentResult[]): ISubagentClient {
  return {
    async send() {
      const next = queue.shift();
      if (!next) return { kind: 'content', content: '' };
      return next;
    },
  };
}

function stubRag(): IKnowledgeRagHandle {
  return {
    query: async () => [],
    async list() {
      return [];
    },
    async write() {},
    fingerprint() {
      return 'stub';
    },
  };
}

const stubEmbedder = {
  embed: async () => ({ vector: [1, 0, 0] }),
} as never;

function baseConfig(): ControllerConfig {
  return {
    subagents: {} as never,
    targetState: { strategy: 'semantic-distance', distanceThreshold: 0.9 },
    sessionMemory: { collection: 'controller' },
    budgets: { maxSteps: 10, maxRetries: 2, maxRewinds: 3 },
  };
}

function makeDeps(backend: InMemoryKnowledgeBackend): ControllerHandlerDeps {
  const rag = stubRag();
  return {
    evaluator: scriptedClient([
      { kind: 'content', content: 'Goal: read table T000' },
    ]),
    planner: scriptedClient([
      {
        kind: 'content',
        content: JSON.stringify({ kind: 'done', result: 'done reading T000' }),
      },
    ]),
    executor: scriptedClient([]),
    backend,
    knowledgeRagFor: () => rag,
    embedder: stubEmbedder,
    callMcp: async () => 'mcp-out',
    selectTools: async () => [],
    isExternalTool: () => false,
    config: baseConfig(),
    models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
  };
}

test('#213: fresh run logs classify + a run line with a REAL runId (never undefined)', async () => {
  const captured: Captured[] = [];
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest('sess-diag');
  const ctx = {
    sessionId: 'sess-diag',
    textOrMessages: 'read table T000',
    options: undefined,
    externalResults: undefined,
    requestLogger,
    yield: (c: Captured) => captured.push(c),
  } as unknown as PipelineContext;

  const handler = new ControllerCoordinatorHandler(
    makeDeps(new InMemoryKnowledgeBackend()),
  );
  await handler.execute(ctx, {}, undefined);

  const classify = lines.find((l) => l.includes('classify '));
  assert.ok(classify, 'a classify line is emitted');
  assert.match(classify, /session=sess-diag/);
  assert.match(classify, /cls=fresh/);

  const run = lines.find((l) => l.includes('] run '));
  assert.ok(run, 'a run line is emitted once identity is settled');
  assert.match(run, /session=sess-diag/);
  assert.doesNotMatch(run, /run=undefined/, 'runId must be minted by now');
  assert.match(run, /run=run-/);
});

test('#213: DEBUG_CONTROLLER unset → no diagnostic lines (zero default noise)', async () => {
  delete process.env.DEBUG_CONTROLLER;
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest('sess-quiet');
  const ctx = {
    sessionId: 'sess-quiet',
    textOrMessages: 'read table T000',
    options: undefined,
    externalResults: undefined,
    requestLogger,
    yield: () => {},
  } as unknown as PipelineContext;

  const handler = new ControllerCoordinatorHandler(
    makeDeps(new InMemoryKnowledgeBackend()),
  );
  await handler.execute(ctx, {}, undefined);

  assert.deepEqual(
    lines.filter((l) => l.includes('[controller] classify')),
    [],
  );
});
