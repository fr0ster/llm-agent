/**
 * Spec §10.5.2 N2 (D87): a controller step whose executor emits tool-call
 * arguments that are not valid JSON never runs the tool — the step's tool
 * result is the error, which the executor sees on its next turn.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IKnowledgeRagHandle,
  type KnowledgeEntry,
  type LlmTool,
  type Message,
  type StreamToolCall,
  symmetricEmbedder,
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

function fakeCtx(
  steps: Array<{ name: string; data: unknown }>,
): PipelineContext {
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest('sess-args');
  return {
    sessionId: 'sess-args',
    textOrMessages: 'do the thing',
    options: {
      sessionLogger: {
        logStep(name: string, data: unknown) {
          steps.push({ name, data });
        },
      },
    },
    externalResults: undefined,
    requestLogger,
    yield: () => {},
  } as unknown as PipelineContext;
}

function scriptedClient(
  queue: SubagentResult[],
  seen?: Message[][],
): ISubagentClient {
  return {
    async send(messages: Message[]) {
      seen?.push([...messages]);
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
    query: async () => [],
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

const stubEmbedder = symmetricEmbedder({
  embed: async () => ({ vector: [1, 0, 0] }),
}) as never;

function baseConfig(): ControllerConfig {
  return {
    subagents: {} as never,
    targetState: { strategy: 'semantic-distance', distanceThreshold: 0.9 },
    sessionMemory: { collection: 'controller' },
    budgets: { maxSteps: 10, maxRetries: 2, maxRewinds: 3 },
  };
}

async function runStep(call: StreamToolCall) {
  const mcpCalls: Array<{ name: string; args: unknown }> = [];
  const executorSeen: Message[][] = [];
  const steps: Array<{ name: string; data: unknown }> = [];
  const deps: ControllerHandlerDeps = {
    evaluator: scriptedClient([
      { kind: 'content', content: 'Goal: do the thing' },
    ]),
    planner: scriptedClient([
      {
        kind: 'content',
        content: JSON.stringify({
          plan: [{ name: 's1', instructions: 'fetch data' }],
        }),
      },
      { kind: 'content', content: 'final answer' },
    ]),
    executor: scriptedClient(
      [
        { kind: 'tool_call', toolCalls: [call] },
        { kind: 'content', content: 'saw the error, done' },
      ],
      executorSeen,
    ),
    backend: new InMemoryKnowledgeBackend(),
    knowledgeRagFor: () => stubRag(),
    embedder: stubEmbedder,
    callMcp: async (name, args) => {
      mcpCalls.push({ name, args });
      return 'ran';
    },
    selectTools: async (): Promise<LlmTool[]> => [
      { name: 'GetTable', description: '', inputSchema: {} },
    ],
    isExternalTool: () => false,
    config: baseConfig(),
    models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
  };
  const ret = await new ControllerCoordinatorHandler(deps).execute(
    fakeCtx(steps),
    {},
    undefined as never,
  );
  return { ret, mcpCalls, executorSeen, steps };
}

describe('controller: invalid tool-call arguments never run the tool (spec D87)', () => {
  it('string arguments that do not parse → not called; the tool result carries the code', async () => {
    const { mcpCalls, executorSeen, steps } = await runStep({
      index: 0,
      id: 'c1',
      name: 'GetTable',
      arguments: '{"a":',
    });
    assert.equal(mcpCalls.length, 0, 'the tool must not run with {}');
    const second = executorSeen[1] ?? [];
    const tool = second.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'c1',
    );
    assert.ok(tool, `executor saw the tool result: ${JSON.stringify(second)}`);
    assert.match(String(tool.content), /TOOL_ARGUMENTS_JSON_PARSE_FAILED/);
    assert.match(String(tool.content), /arguments of tool "GetTable"/);
    const step = steps.find((s) => s.name === 'tool_arguments_invalid');
    assert.ok(step, 'tool_arguments_invalid logged');
    assert.equal(
      (step.data as { code: string }).code,
      'TOOL_ARGUMENTS_JSON_PARSE_FAILED',
    );
  });

  it('a call an adapter marked (object arm) is refused too', async () => {
    const { mcpCalls, executorSeen } = await runStep({
      id: 'c1',
      name: 'GetTable',
      arguments: {},
      argumentsError: 'SyntaxError: x',
    });
    assert.equal(mcpCalls.length, 0);
    const tool = (executorSeen[1] ?? []).find((m) => m.role === 'tool');
    assert.match(String(tool?.content), /TOOL_ARGUMENTS_JSON_PARSE_FAILED/);
  });

  it('valid string arguments still run the tool', async () => {
    const { mcpCalls } = await runStep({
      index: 0,
      id: 'c1',
      name: 'GetTable',
      arguments: '{"table":"T"}',
    });
    assert.deepEqual(mcpCalls, [{ name: 'GetTable', args: { table: 'T' } }]);
  });
});
