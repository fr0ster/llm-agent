import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IKnowledgeRagHandle,
  ILlm,
  LlmError,
  LlmResponse,
  LlmTool,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { buildFromComposition } from '../build-stepper-root.js';

for (const profile of ['cyclic-react', 'recursive', 'simple'] as const) {
  test(`Stepper ${profile} uses the configured executor profile without a default tool-loop budget`, async () => {
    let rounds = 0;
    let calls = 0;
    const tool: LlmTool = {
      name: 'Work',
      description: 'Work',
      inputSchema: {},
    };
    const executor: ILlm = {
      async chat(): Promise<Result<LlmResponse, LlmError>> {
        rounds++;
        return {
          ok: true,
          value:
            rounds <= 12
              ? {
                  content: '',
                  finishReason: 'tool_calls',
                  toolCalls: [
                    {
                      id: `c${rounds}`,
                      name: tool.name,
                      arguments: { round: rounds },
                    },
                  ],
                }
              : { content: 'done', finishReason: 'stop' },
        };
      },
      streamChat() {
        throw new Error('The Stepper uses chat');
      },
    };
    const helper: ILlm = {
      async chat() {
        return {
          ok: true,
          value: { content: '{"need":false}', finishReason: 'stop' },
        };
      },
      streamChat() {
        throw new Error('The Stepper uses chat');
      },
    };
    const rag: IKnowledgeRagHandle = {
      query: async () => [],
      list: async () => [],
      write: async () => {},
      fingerprint: () => 'stepper-limits',
    };
    const built = await buildFromComposition(
      {
        planner: 'none',
        granularity: 'shallow',
        executor: profile,
        finalizer: 'llm',
        evaluatorEnabled: false,
        evaluatorAtDepths: { has: () => false },
        reviewerAtDepths: { has: () => false },
        maxParallelSteps: 1,
        maxDepth: 0,
        tokenBudget: 100_000,
        formalizeTask: false,
      },
      {
        makeRoleLlm: async (role) => (role === 'executor' ? executor : helper),
        callMcp: async () => {
          calls++;
          return 'completed';
        },
        mintStepperId: () => 'root',
        registry: new Map(),
      },
    );
    const result = await built.rootStepper.run({
      caller: { sessionId: 's', userId: 'test-user', isAdmin: false },
      prompt: 'complete the work',
      knowledgeRag: rag,
      toolsRag: { query: async () => [tool], lookup: () => tool },
      budget: built.budget,
      identity: {
        traceId: 't',
        turnId: 'u',
        sessionId: 's',
        stepperId: 'root',
      },
    });
    assert.equal(rounds, profile === 'simple' ? 2 : 13);
    assert.equal(calls, profile === 'simple' ? 2 : 12);
    assert.equal(result.status, profile === 'simple' ? 'incomplete' : 'ok');
  });
}
