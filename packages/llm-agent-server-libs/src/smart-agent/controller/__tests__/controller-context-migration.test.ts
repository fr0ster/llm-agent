/**
 * Task 12: controller resume + one-release migration.
 *
 * On resume, `runStep` selects the per-step context strategy by what the in-flight
 * step carries:
 *  - (a) a serialized `contextStrategyState` → `strategy.restore()` + the durable
 *    `controlTail` is re-emitted; the injected external tool pair survives a
 *    further recorded round.
 *  - (b) a PRE-RELEASE in-flight step with ONLY a raw `transcript` (no snapshot) →
 *    migrates verbatim via `LegacyTranscriptContextStrategy` and completes with no
 *    context loss, no crash, and no double-record.
 *  - (c) a step that recorded an INTERNAL tool round BEFORE it suspended on an
 *    external tool → the pre-suspend internal round comes back after resume
 *    (closes the Task-11 fresh-only gap where it was lost).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  externalToolCallId,
  type IKnowledgeRagHandle,
  type KnowledgeEntry,
  type LlmStreamChunk,
  type LlmTool,
  type Message,
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
import { hydrateBundle, persistBundle } from '../session-bundle.js';
import type { ISubagentClient } from '../subagent-client.js';
import type { ControllerConfig, SubagentResult } from '../types.js';

// ---------------------------------------------------------------------------
// Scaffolding (mirrors round-trip.test.ts / controller-context-strategy.test.ts)
// ---------------------------------------------------------------------------

type Captured = Result<LlmStreamChunk, unknown>;

function fakeCtx(overrides: {
  sessionId: string;
  externalResults?: Map<string, string>;
}): { ctx: PipelineContext; captured: Captured[] } {
  const captured: Captured[] = [];
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest(overrides.sessionId);
  const ctx = {
    sessionId: overrides.sessionId,
    textOrMessages: 'do the thing',
    options: undefined,
    externalResults: overrides.externalResults,
    requestLogger,
    yield: (c: Captured) => {
      captured.push(c);
    },
  } as unknown as PipelineContext;
  return { ctx, captured };
}

function scriptedClient(queue: SubagentResult[]): ISubagentClient {
  return {
    async send() {
      const next = queue.shift();
      if (!next) return { kind: 'content', content: '' };
      return next;
    },
  };
}

/** Executor stub that records every messages[] it is asked to send. */
function recordingExecutor(queue: SubagentResult[]): {
  client: ISubagentClient;
  rounds: Message[][];
} {
  const rounds: Message[][] = [];
  return {
    rounds,
    client: {
      async send(messages: Message[]) {
        rounds.push(messages);
        const next = queue.shift();
        if (!next) return { kind: 'content', content: '' };
        return next;
      },
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
  toolCalls: [{ id: `c-${name}`, name, arguments: args }],
});

/** A serialized LegacyAccumulate snapshot carrying one internal tool round. */
function internalRoundState(id: string, content: string) {
  return {
    version: 1,
    rounds: [
      {
        assistant: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id,
              type: 'function',
              function: { name: 'GetInternal', arguments: '{}' },
            },
          ],
        },
        results: [{ role: 'tool', tool_call_id: id, content }],
      },
    ],
  };
}

function countContent(rounds: Message[][], needle: string): number {
  let n = 0;
  for (const msgs of rounds) {
    for (const m of msgs) {
      if (typeof m.content === 'string' && m.content.includes(needle)) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('controller resume + migration (Task 12)', () => {
  it('(a) contextStrategyState present → restore + controlTail; external pair survives a further round', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();
    const extId = externalToolCallId('ExtTool', { q: 'x' });

    // Seed a bundle that suspended on ExtTool AFTER recording one internal round,
    // with a durable control-tail message.
    await persistBundle(backend, 'sess-a', {
      goal: 'g',
      plannerPrivate: '',
      budgets: { stepsUsed: 0, rewindsUsed: 0 },
      runId: 'R1',
      runState: 'suspended',
      runPhase: 'executing',
      originalRequest: 'do the thing',
      nextSeq: 0,
      plan: [{ name: 's1', instructions: 'i' }],
      planCursor: 0,
      inFlightStep: {
        seq: 0,
        step: { name: 's1', instructions: 'i' },
        attempt: 0,
        resumeCount: 0,
        phase: 'executing',
        transcript: [],
        toolCallCount: 1,
        contextStrategyState: internalRoundState('i1', 'PRE-SUSPEND INTERNAL'),
        controlTail: [{ role: 'user', content: 'CTRL-TAIL-MARK' }],
      },
      pending: {
        kind: 'external-tool',
        extId,
        toolName: 'ExtTool',
        args: { q: 'x' },
        position: 's1',
      },
    } as never);

    // Resume: executor makes ONE more internal call, then finishes.
    const exec = recordingExecutor([
      toolCall('GetMore', {}),
      { kind: 'content', content: 'continued' },
    ]);
    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([]),
      planner: scriptedClient([{ kind: 'content', content: 'FINAL-A' }]),
      executor: exec.client,
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async () => ({ text: 'MORE DATA', isError: false }),
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'GetMore', description: '', inputSchema: {} },
      ],
      isExternalTool: (n) => n === 'ExtTool',
      config: baseConfig(),
      models: { evaluator: 'm', planner: 'm', executor: 'm' },
    };

    const { ctx } = fakeCtx({
      sessionId: 'sess-a',
      externalResults: new Map([[extId, 'EXT RESULT']]),
    });
    const ret = await new ControllerCoordinatorHandler(deps).execute(
      ctx,
      {},
      undefined,
    );
    assert.equal(ret, true);

    // First executor send: restored internal round + injected external pair +
    // the durable control tail message are ALL present.
    const first = exec.rounds[0] ?? [];
    assert.ok(
      first.some((m) => m.content === 'PRE-SUSPEND INTERNAL'),
      '(a) restored internal round present',
    );
    assert.ok(
      first.some((m) => m.content === 'EXT RESULT'),
      '(a) external result present after restore',
    );
    assert.ok(
      first.some((m) => m.content === 'CTRL-TAIL-MARK'),
      '(a) durable controlTail re-emitted',
    );

    // The external pair survives into the send AFTER a further recorded round.
    const second = exec.rounds[1] ?? [];
    assert.ok(
      second.some((m) => m.content === 'EXT RESULT'),
      '(a) external pair survives a further round',
    );
    assert.ok(
      second.some((m) => m.content === 'MORE DATA'),
      '(a) the further internal round is recorded',
    );

    const b = await hydrateBundle(backend, 'sess-a');
    assert.equal(b.pending, undefined, '(a) pending cleared');
  });

  it('(b) pre-release step with ONLY transcript → LegacyTranscript migration completes with no context loss, no double', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();

    // Pre-release in-flight step: a raw transcript, NO contextStrategyState, NO
    // pending (a plain crash-replay resume).
    await persistBundle(backend, 'sess-b', {
      goal: 'g',
      plannerPrivate: '',
      budgets: { stepsUsed: 0, rewindsUsed: 0 },
      runId: 'R2',
      runState: 'active',
      runPhase: 'executing',
      originalRequest: 'do the thing',
      nextSeq: 0,
      plan: [{ name: 's1', instructions: 'i' }],
      planCursor: 0,
      inFlightStep: {
        seq: 0,
        step: { name: 's1', instructions: 'i' },
        attempt: 0,
        resumeCount: 0,
        phase: 'executing',
        toolCallCount: 1,
        transcript: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'legacy-1',
                type: 'function',
                function: { name: 'GetOld', arguments: '{}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'legacy-1',
            content: 'LEGACY TRANSCRIPT DATA',
          },
        ],
      },
    } as never);

    const exec = recordingExecutor([{ kind: 'content', content: 'migrated' }]);
    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([]),
      planner: scriptedClient([{ kind: 'content', content: 'FINAL-B' }]),
      executor: exec.client,
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async () => ({ text: 'unused', isError: false }),
      selectTools: async (): Promise<LlmTool[]> => [],
      isExternalTool: () => false,
      config: baseConfig(),
      models: { evaluator: 'm', planner: 'm', executor: 'm' },
    };

    const { ctx } = fakeCtx({ sessionId: 'sess-b' });
    const ret = await new ControllerCoordinatorHandler(deps).execute(
      ctx,
      {},
      undefined,
    );
    assert.equal(ret, true, '(b) run completes, no crash');

    // The legacy transcript data reaches the executor (no context loss) and does
    // so EXACTLY ONCE (migration adopts it; the bridge does NOT re-inject it).
    assert.ok(
      (exec.rounds[0] ?? []).some(
        (m) => m.content === 'LEGACY TRANSCRIPT DATA',
      ),
      '(b) legacy transcript surfaced to executor',
    );
    assert.equal(
      countContent(exec.rounds, 'LEGACY TRANSCRIPT DATA'),
      1,
      '(b) no double-record of the migrated transcript',
    );

    const b = await hydrateBundle(backend, 'sess-b');
    assert.equal(b.pending, undefined);
  });

  it('(c) internal round BEFORE an external suspend is restored on resume (Task-11 gap)', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();
    const extId = externalToolCallId('ExtTool', { q: 'y' });

    await persistBundle(backend, 'sess-c', {
      goal: 'g',
      plannerPrivate: '',
      budgets: { stepsUsed: 0, rewindsUsed: 0 },
      runId: 'R3',
      runState: 'suspended',
      runPhase: 'executing',
      originalRequest: 'do the thing',
      nextSeq: 0,
      plan: [{ name: 's1', instructions: 'i' }],
      planCursor: 0,
      inFlightStep: {
        seq: 0,
        step: { name: 's1', instructions: 'i' },
        attempt: 0,
        resumeCount: 0,
        phase: 'executing',
        transcript: [],
        toolCallCount: 1,
        contextStrategyState: internalRoundState(
          'pre-1',
          'INTERNAL-BEFORE-SUSPEND',
        ),
      },
      pending: {
        kind: 'external-tool',
        extId,
        toolName: 'ExtTool',
        args: { q: 'y' },
        position: 's1',
      },
    } as never);

    const exec = recordingExecutor([{ kind: 'content', content: 'done' }]);
    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([]),
      planner: scriptedClient([{ kind: 'content', content: 'FINAL-C' }]),
      executor: exec.client,
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async () => ({ text: 'unused', isError: false }),
      selectTools: async (): Promise<LlmTool[]> => [],
      isExternalTool: (n) => n === 'ExtTool',
      config: baseConfig(),
      models: { evaluator: 'm', planner: 'm', executor: 'm' },
    };

    const { ctx } = fakeCtx({
      sessionId: 'sess-c',
      externalResults: new Map([[extId, 'EXT RESULT C']]),
    });
    const ret = await new ControllerCoordinatorHandler(deps).execute(
      ctx,
      {},
      undefined,
    );
    assert.equal(ret, true);

    const first = exec.rounds[0] ?? [];
    // The pre-suspend INTERNAL round is NOT lost (the Task-11 fresh-only gap).
    assert.ok(
      first.some((m) => m.content === 'INTERNAL-BEFORE-SUSPEND'),
      '(c) pre-suspend internal round restored after resume',
    );
    assert.ok(
      first.some((m) => m.content === 'EXT RESULT C'),
      '(c) external result also present',
    );
  });

  it('(d) SECOND resume of a migrated step keeps migrated rawMessages + post-migration rounds', async () => {
    // A pre-release step (transcript only) migrates on the FIRST resume →
    // LegacyTranscriptContextStrategy, whose snapshot() is {rawMessages,newRounds}
    // (NO `rounds`). When that step suspends on an external tool, the SECOND resume
    // takes the RESTORE branch. If the restore uses the injected/default
    // LegacyAccumulateContextStrategy (reads ONLY `state.rounds`), BOTH the migrated
    // raw history AND any post-migration recorded round are silently dropped. The
    // fix discriminates on snapshot shape and restores a LegacyTranscript snapshot
    // through the SAME strategy type. This asserts the "no lost rounds" guarantee
    // across a second resume.
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();
    const extId = externalToolCallId('ExtTool', { q: 'z' });

    // --- FIRST resume: pre-release in-flight step, transcript ONLY, no snapshot.
    await persistBundle(backend, 'sess-d', {
      goal: 'g',
      plannerPrivate: '',
      budgets: { stepsUsed: 0, rewindsUsed: 0 },
      runId: 'R4',
      runState: 'active',
      runPhase: 'executing',
      originalRequest: 'do the thing',
      nextSeq: 0,
      plan: [{ name: 's1', instructions: 'i' }],
      planCursor: 0,
      inFlightStep: {
        seq: 0,
        step: { name: 's1', instructions: 'i' },
        attempt: 0,
        resumeCount: 0,
        phase: 'executing',
        toolCallCount: 0,
        transcript: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'legacy-d',
                type: 'function',
                function: { name: 'GetOld', arguments: '{}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'legacy-d',
            content: 'LEGACY TRANSCRIPT DATA',
          },
        ],
      },
    } as never);

    // First resume executor: one INTERNAL round (records POST-MIGRATION ROUND into
    // the migrated strategy), then an EXTERNAL call → suspend (snapshots the
    // LegacyTranscript state: rawMessages + the post-migration round).
    const exec1 = recordingExecutor([
      toolCall('GetMore', {}),
      toolCall('ExtTool', { q: 'z' }),
    ]);
    const deps1: ControllerHandlerDeps = {
      evaluator: scriptedClient([]),
      planner: scriptedClient([{ kind: 'content', content: 'FINAL-D' }]),
      executor: exec1.client,
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async () => ({ text: 'POST-MIGRATION ROUND', isError: false }),
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'GetMore', description: '', inputSchema: {} },
      ],
      isExternalTool: (n) => n === 'ExtTool',
      config: baseConfig(),
      models: { evaluator: 'm', planner: 'm', executor: 'm' },
    };
    const { ctx: ctx1 } = fakeCtx({ sessionId: 'sess-d' });
    const ret1 = await new ControllerCoordinatorHandler(deps1).execute(
      ctx1,
      {},
      undefined,
    );
    assert.equal(ret1, true, '(d) first resume suspends on external tool');

    // The suspended bundle now carries a LegacyTranscript-shaped snapshot.
    const suspended = await hydrateBundle(backend, 'sess-d');
    assert.equal(suspended.runState, 'suspended', '(d) first resume suspended');
    assert.ok(
      (
        suspended.inFlightStep?.contextStrategyState as {
          rawMessages?: unknown;
        }
      )?.rawMessages !== undefined,
      '(d) persisted snapshot is LegacyTranscript-shaped (has rawMessages)',
    );

    // --- SECOND resume: restore the migrated step + resolve the external tool.
    const exec2 = recordingExecutor([{ kind: 'content', content: 'done-d' }]);
    const deps2: ControllerHandlerDeps = {
      evaluator: scriptedClient([]),
      planner: scriptedClient([{ kind: 'content', content: 'FINAL-D' }]),
      executor: exec2.client,
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async () => ({ text: 'unused', isError: false }),
      selectTools: async (): Promise<LlmTool[]> => [],
      isExternalTool: (n) => n === 'ExtTool',
      config: baseConfig(),
      models: { evaluator: 'm', planner: 'm', executor: 'm' },
    };
    const { ctx: ctx2 } = fakeCtx({
      sessionId: 'sess-d',
      externalResults: new Map([[extId, 'EXT RESULT D']]),
    });
    const ret2 = await new ControllerCoordinatorHandler(deps2).execute(
      ctx2,
      {},
      undefined,
    );
    assert.equal(ret2, true, '(d) second resume completes');

    // The migrated raw history AND the post-migration round survive the SECOND
    // resume (dropped by the buggy LegacyAccumulate restore of a LegacyTranscript
    // snapshot; preserved by shape-discriminated restore).
    const s2 = exec2.rounds[0] ?? [];
    assert.ok(
      s2.some((m) => m.content === 'LEGACY TRANSCRIPT DATA'),
      '(d) migrated rawMessages survive the second resume',
    );
    assert.ok(
      s2.some((m) => m.content === 'POST-MIGRATION ROUND'),
      '(d) post-migration recorded round survives the second resume',
    );
    assert.ok(
      s2.some((m) => m.content === 'EXT RESULT D'),
      '(d) external result also present after second resume',
    );
  });
});
