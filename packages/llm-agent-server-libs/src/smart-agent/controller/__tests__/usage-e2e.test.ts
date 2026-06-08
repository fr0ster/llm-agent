import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IKnowledgeRagHandle,
  IStageHandler,
  LlmStreamChunk,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  InMemoryKnowledgeBackend,
  type PipelineContext,
  SessionRequestLogger,
  summaryToUsage,
  wrapEmbedder,
} from '@mcp-abap-adt/llm-agent-libs';
import type { ControllerHandlerDeps } from '../controller-coordinator-handler.js';
import { ControllerCoordinatorHandler } from '../controller-coordinator-handler.js';
import type { ISubagentClient } from '../subagent-client.js';
import type { ControllerConfig, SubagentResult } from '../types.js';

const usage = { promptTokens: 10, completionTokens: 4, totalTokens: 14 };

function client(results: SubagentResult[]): ISubagentClient {
  let i = 0;
  return {
    async send() {
      return results[i++] ?? { kind: 'content', content: '' };
    },
  };
}

const rag: IKnowledgeRagHandle = {
  query: async () => [],
  list: async () => [],
  write: async () => {},
  fingerprint: () => 'stub',
};

const config: ControllerConfig = {
  subagents: {} as never,
  targetState: { strategy: 'semantic-distance', distanceThreshold: 0.9 },
  sessionMemory: { collection: 'c' },
  budgets: { maxSteps: 5, maxRetries: 2, maxRewinds: 2 },
};

test('controller terminal usage == getSummary(traceId), includes subagents + embedding', async () => {
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest('sess-e2e');

  // Wrapped embedder that reports usage → logged as component:'embedding'.
  const embedder = wrapEmbedder({
    embed: async () => ({
      vector: [1, 0, 0],
      usage: { promptTokens: 3, totalTokens: 3 },
    }),
  });

  const deps: ControllerHandlerDeps = {
    evaluator: client([{ kind: 'content', content: 'Goal: read T100', usage }]),
    planner: client([
      {
        kind: 'content',
        content: JSON.stringify({ kind: 'done', result: 'T100 has 4 fields.' }),
        usage,
      },
    ]),
    executor: client([]),
    backend: new InMemoryKnowledgeBackend(),
    knowledgeRagFor: () => rag,
    embedder,
    callMcp: async () => 'out',
    selectTools: async () => [],
    config,
    models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
  };

  const captured: Result<LlmStreamChunk, unknown>[] = [];
  const ctx = {
    sessionId: 'sess-e2e',
    textOrMessages: 'Read table T100',
    options: { trace: { traceId: 'sess-e2e' }, requestLogger },
    externalResults: undefined,
    requestLogger,
    yield: (c: Result<LlmStreamChunk, unknown>) => captured.push(c),
  } as unknown as PipelineContext;

  const handler: IStageHandler = new ControllerCoordinatorHandler(deps);
  await handler.execute(ctx, {}, undefined as never);

  // Terminal chunk carries usage.
  const terminal = captured
    .map((c) => (c.ok ? c.value : undefined))
    .filter(
      (v): v is LlmStreamChunk => !!v && v.finishReason === 'stop' && !!v.usage,
    )
    .pop();
  assert.ok(terminal, 'expected a terminal stop chunk with usage');

  const summary = requestLogger.getSummary('sess-e2e');
  const expected = summaryToUsage(summary);
  assert.equal(terminal.usage?.totalTokens, expected.totalTokens);
  assert.ok(terminal.usage?.models, 'usage.models present');

  // byComponent has the subagent roles + embedding.
  assert.ok(summary.byComponent.evaluator, 'evaluator logged');
  assert.ok(summary.byComponent.planner, 'planner logged');
  assert.ok(summary.byComponent.embedding, 'embedding logged');
  // Total == evaluator(14) + planner(14) + 2 embeds(3+3) = 34.
  assert.equal(expected.totalTokens, 34);
});
