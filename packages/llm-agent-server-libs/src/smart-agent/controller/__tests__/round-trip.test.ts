import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  externalToolCallId,
  type IKnowledgeRagHandle,
  type KnowledgeEntry,
  type LlmStreamChunk,
  type Result,
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
import { hydrateBundle } from '../session-bundle.js';
import type { ISubagentClient } from '../subagent-client.js';
import type { ControllerConfig, SubagentResult } from '../types.js';

// ---------------------------------------------------------------------------
// Shared test scaffolding — mirrors controller-coordinator-handler.test.ts
// ---------------------------------------------------------------------------

type Captured = Result<LlmStreamChunk, unknown>;

function fakeCtx(overrides: {
  sessionId: string;
  textOrMessages: string;
  externalResults?: Map<string, string>;
}): { ctx: PipelineContext; captured: Captured[] } {
  const captured: Captured[] = [];
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest(overrides.sessionId);
  const ctx = {
    sessionId: overrides.sessionId,
    textOrMessages: overrides.textOrMessages,
    options: undefined,
    externalResults: overrides.externalResults,
    requestLogger,
    yield: (c: Captured) => {
      captured.push(c);
    },
  } as unknown as PipelineContext;
  return { ctx, captured };
}

/** Subagent stub backed by a scripted queue; each send() shifts one result. */
function scriptedClient(queue: SubagentResult[]): ISubagentClient & {
  calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async send() {
      calls++;
      const next = queue.shift();
      if (!next) return { kind: 'content', content: '' };
      return next;
    },
  };
}

function stubRag(): IKnowledgeRagHandle & { written: KnowledgeEntry[] } {
  const written: KnowledgeEntry[] = [];
  return {
    written,
    async query() {
      return [];
    },
    async list() {
      return [];
    },
    async write(entry) {
      written.push(entry);
    },
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

const toolCall = (
  name: string,
  args: Record<string, unknown>,
): SubagentResult => ({
  kind: 'tool_call',
  toolCalls: [{ id: 'c1', name, arguments: args }],
});

// ---------------------------------------------------------------------------
// Suspend / resume round-trip
// ---------------------------------------------------------------------------

describe('ControllerCoordinatorHandler – suspend/resume round-trip', () => {
  it('external-tool suspend then resume across two separate execute() calls', async () => {
    const SESSION_ID = 'rt-sess-1';
    const TOOL_NAME = 'ExtTool';
    const TOOL_ARGS = { q: 'abc' };

    // Shared durable backend — the key ingredient that bridges the two legs.
    const sharedBackend = new InMemoryKnowledgeBackend();
    const rag = stubRag();

    // ------------------------------------------------------------------
    // Leg 1: executor hits an external tool → handler must suspend
    // ------------------------------------------------------------------

    const leg1Evaluator = scriptedClient([
      { kind: 'content', content: 'Goal: do work' },
    ]);
    const leg1Planner = scriptedClient([
      {
        kind: 'content',
        content: JSON.stringify({ plan: [{ name: 's1', instructions: 'do' }] }),
      },
    ]);
    const leg1Executor = scriptedClient([toolCall(TOOL_NAME, TOOL_ARGS)]);

    const leg1Deps: ControllerHandlerDeps = {
      evaluator: leg1Evaluator,
      planner: leg1Planner,
      executor: leg1Executor,
      backend: sharedBackend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async () => 'mcp-out',
      selectTools: async () => [],
      isExternalTool: () => true,
      config: baseConfig(),
      models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
    };

    const handler1 = new ControllerCoordinatorHandler(leg1Deps);
    const { ctx: ctx1, captured: captured1 } = fakeCtx({
      sessionId: SESSION_ID,
      textOrMessages: 'do work',
      externalResults: undefined,
    });

    const ret1 = await handler1.execute(ctx1, {}, undefined);

    // Assertions: leg 1
    assert.equal(ret1, true, 'leg 1 returns true');

    const surfaced = captured1.find(
      (c) =>
        c.ok &&
        c.value.finishReason === 'tool_calls' &&
        (c.value.toolCalls?.length ?? 0) > 0,
    );
    assert.ok(surfaced, 'leg 1: tool_calls chunk surfaced to caller');

    const bundle1 = await hydrateBundle(sharedBackend, SESSION_ID);
    assert.equal(
      bundle1.pending?.kind,
      'external-tool',
      'leg 1: pending.kind === external-tool',
    );

    const expectedExtId = externalToolCallId(TOOL_NAME, TOOL_ARGS);
    const actualExtId =
      bundle1.pending?.kind === 'external-tool' ? bundle1.pending.extId : '';
    assert.equal(
      actualExtId,
      expectedExtId,
      'leg 1: pending.extId matches externalToolCallId()',
    );

    // Capture extId for leg 2 (must be consistent with the computed value).
    const extId = expectedExtId;

    // ------------------------------------------------------------------
    // Leg 2: resume — provide the external tool result; planner completes
    // ------------------------------------------------------------------

    const leg2Evaluator = scriptedClient([
      { kind: 'content', content: 'Goal: do work' },
    ]);
    // On resume the step continues: the external tool result is injected into the
    // in-flight step's transcript and the executor re-runs the step (continues
    // from its own tool call). Once the step commits, the plan is exhausted →
    // FINALIZE_SYSTEM call → plain text.
    const leg2Planner = scriptedClient([
      { kind: 'content', content: 'all done' },
    ]);
    // The executor IS called once on resume: the tool result is in its transcript
    // and it completes the step.
    const leg2Executor = scriptedClient([
      { kind: 'content', content: 'continued with tool result' },
    ]);

    const leg2Deps: ControllerHandlerDeps = {
      evaluator: leg2Evaluator,
      planner: leg2Planner,
      executor: leg2Executor,
      // SAME backend — resumes the persisted bundle.
      backend: sharedBackend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async () => 'mcp-out',
      selectTools: async () => [],
      isExternalTool: () => true,
      config: baseConfig(),
      models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
    };

    const handler2 = new ControllerCoordinatorHandler(leg2Deps);
    // Use the same textOrMessages as leg 1 so classifyRequest fingerprints match
    // the originalRequest and classifies this as a 'resume' (not 'fresh').
    const { ctx: ctx2, captured: captured2 } = fakeCtx({
      sessionId: SESSION_ID,
      textOrMessages: 'do work',
      externalResults: new Map([[extId, 'TOOL RESULT']]),
    });

    const ret2 = await handler2.execute(ctx2, {}, undefined);

    // Assertions: leg 2
    assert.equal(ret2, true, 'leg 2 returns true');

    const finalChunk = captured2.find(
      (c) =>
        c.ok &&
        c.value.finishReason === 'stop' &&
        c.value.content === 'all done',
    );
    assert.ok(
      finalChunk,
      'leg 2: final stop chunk with content "all done" was yielded',
    );

    const bundle2 = await hydrateBundle(sharedBackend, SESSION_ID);
    assert.equal(
      bundle2.pending,
      undefined,
      'leg 2: pending cleared after resume',
    );

    assert.equal(
      leg2Executor.calls,
      1,
      'leg 2: executor re-runs the step once with the external tool result in its transcript',
    );
  });
});
