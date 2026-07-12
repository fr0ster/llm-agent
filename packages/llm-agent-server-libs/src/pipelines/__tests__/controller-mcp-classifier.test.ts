/**
 * Regression test for the `pipeline: controller` MCP-failure-classifier wiring.
 *
 * The controller plugin builds its OWN MCP bridge (`buildMcpBridge`) for the
 * handler's `callMcp`. It MUST forward `ctx.mcpFailureClassifier` into that
 * bridge — otherwise a consumer's custom classifier (injected via SmartServer/
 * builder DI and placed on the pipeline ctx) is silently dropped for the
 * controller path and the bridge falls back to `DefaultMcpFailureClassifier`.
 *
 * Discriminating assertion: a spy classifier placed on the ctx is consulted
 * during a controller run that hits a failing MCP tool. On the pre-fix code
 * (`buildMcpBridge(mcpClients)`), the ctx classifier is ignored → the spy is
 * never called (calls === 0) → this test FAILS. After the fix
 * (`buildMcpBridge(mcpClients, ctx.mcpFailureClassifier)`) it PASSES.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IEmbedder,
  type ILlm,
  type IMcpClient,
  type IMcpFailureClassifier,
  type LlmResponse,
  type LlmTool,
  McpError,
  type McpFailureKind,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryKnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import { makeKnowledgeSemanticIndex } from '../../smart-agent/embedder-knowledge-index.js';
import { ControllerPipelinePlugin } from '../controller.js';
import { fakeControllerServerCtx } from './fixtures.js';

// Non-zero constant embedder so goal/prompt semantic distance is 0 (target-state
// established, not the ambiguity gate): the fixture's dim-1 [0] embedder yields
// distance 1.00, which makes the controller ask for clarification and suspend
// BEFORE it ever plans/executes.
const constEmbedder: IEmbedder = {
  embed: async () => ({ vector: [1, 0, 0] }),
  dimensions: 3,
} as unknown as IEmbedder;

// A stateful scripted LLM: chat() shifts the next queued response; an exhausted
// queue returns benign empty content so an unexpected extra round-trip cannot
// crash the run (the assertion is on the classifier spy, not the queue).
function scriptedLlm(model: string, queue: Partial<LlmResponse>[]): ILlm {
  return {
    model,
    chat: async (): Promise<Result<LlmResponse, never>> => {
      const next = queue.shift() ?? { content: '' };
      return {
        ok: true,
        value: { content: '', toolCalls: [], ...next } as LlmResponse,
      };
    },
    streamChat: async function* () {},
  } as unknown as ILlm;
}

const GET_TABLE: LlmTool = {
  name: 'GetTable',
  description: 'get a table',
  inputSchema: { type: 'object' },
} as unknown as LlmTool;

describe('pipeline: controller — MCP failure classifier wiring', () => {
  it('forwards ctx.mcpFailureClassifier into the controller bridge (custom classifier consulted, not silently dropped)', async () => {
    // Spy classifier: records every error it classifies and always maps to
    // 'unavailable' (a custom policy the default would NOT apply to MCP_ERROR).
    const classified: McpError[] = [];
    const spyClassifier: IMcpFailureClassifier = {
      classify: async (error: McpError): Promise<McpFailureKind> => {
        classified.push(error);
        return 'unavailable';
      },
    };

    // Fake MCP client owning GetTable; callTool fails with a tool-level code
    // (MCP_ERROR ∉ MCP_UNAVAILABLE_CODES) so ONLY a forwarded custom classifier
    // can escalate it (the default classifier would keep it as tool feedback).
    const fakeClient: IMcpClient = {
      listTools: async () => ({
        ok: true,
        value: [{ name: 'GetTable', description: '', inputSchema: {} }],
      }),
      callTool: async () => ({
        ok: false,
        error: new McpError('boom', 'MCP_ERROR'),
      }),
    } as unknown as IMcpClient;

    // Per-role scripted LLMs (dispatched by model name), mirroring the handler
    // fail-loud test: evaluator → goal, planner → 1-step plan, executor → a
    // tool call to the internal GetTable (then callMcp throws → abort).
    const byModel: Record<string, ILlm> = {
      'm-eval': scriptedLlm('m-eval', [{ content: 'Goal: do the thing' }]),
      'm-plan': scriptedLlm('m-plan', [
        {
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'fetch data' }],
          }),
        },
        { content: 'done' },
      ]),
      'm-exec': scriptedLlm('m-exec', [
        {
          toolCalls: [
            { id: 'c1', name: 'GetTable', arguments: { table: 'T' } },
          ],
        },
        { content: 'result' },
      ]),
    };

    const plugin = new ControllerPipelinePlugin('controller', 'smart-executor');
    const cfg = plugin.parseConfig({
      subagents: {
        evaluator: { provider: 'openai', model: 'm-eval' },
        planner: { provider: 'openai', model: 'm-plan' },
        executor: { provider: 'openai', model: 'm-exec' },
      },
    });

    const base = fakeControllerServerCtx();
    const ctx = {
      ...base,
      makeLlm: async (c: { model?: string }) =>
        byModel[c.model ?? ''] ?? base.mainLlm,
      // Consistent non-zero embedder + matching semantic-index backend so the
      // goal clears the target-state gate and the run proceeds to plan/execute.
      embedder: constEmbedder,
      stepperKnowledgeBackend: new InMemoryKnowledgeBackend(
        makeKnowledgeSemanticIndex(constEmbedder),
      ),
      // Complete knowledge-rag handle (the controller writes goal/plan/step
      // artifacts through it — the fixture's minimal stub lacks write/list).
      knowledgeRagFor: () => ({
        query: async () => [],
        list: async () => [],
        write: async () => {},
        fingerprint: () => 'stub',
      }),
      // Offer GetTable as an internal tool so the executor's tool_call routes to callMcp.
      toolsRag: {
        query: async () => [GET_TABLE],
        lookup: () => undefined,
      },
      mcpClients: [fakeClient],
      mcpFailureClassifier: spyClassifier,
    } as unknown as Parameters<typeof plugin.build>[1];

    const inst = await plugin.build(cfg, ctx);

    const captured: string[] = [];
    for await (const chunk of inst.agent.streamProcess('do the thing')) {
      if (chunk.ok && typeof chunk.value.content === 'string')
        captured.push(chunk.value.content);
    }
    await inst.close();

    // Discriminating: the ctx spy classifier WAS consulted by the controller's
    // bridge. On the pre-fix code the bridge ignores ctx.mcpFailureClassifier → 0 calls.
    assert.ok(
      classified.length > 0,
      `Expected the ctx.mcpFailureClassifier to be consulted by the controller bridge, but it was never called (calls=${classified.length}). Captured: ${JSON.stringify(captured)}`,
    );
    // And its 'unavailable' verdict surfaces loud (not a silent degrade to (no response)).
    assert.ok(
      captured.some((c) => c.includes('MCP server unavailable')),
      `Expected a loud "MCP server unavailable" chunk. Captured: ${JSON.stringify(captured)}`,
    );
  });
});
