/**
 * D4 contract: flat (non-pipeline) SmartAgent in mode:'hard' must still offer
 * client external tools in the tools[] sent to the LLM.
 * Mode governs only INTERNAL (MCP) execution posture, not external tool surfacing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  LlmError,
  LlmStreamChunk,
  LlmTool,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { makeDefaultDeps } from '../testing/index.js';

const EXTERNAL_TOOL: LlmTool = {
  name: 'client_write_file',
  description: 'Write a file (client-provided)',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
};

function makeSpyLlm() {
  const capturedTools: LlmTool[][] = [];
  const spy = {
    capturedTools,
    async chat() {
      return {
        ok: true as const,
        value: { content: 'ok', finishReason: 'stop' as const },
      };
    },
    async *streamChat(
      _msgs: unknown,
      tools?: LlmTool[],
    ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      capturedTools.push(tools ?? []);
      yield {
        ok: true,
        value: { content: 'done', finishReason: 'stop' as const },
      };
    },
    async healthCheck() {
      return { ok: true as const, value: true };
    },
  };
  return spy;
}

describe('D4 — flat SmartAgent hard mode keeps client external tools', () => {
  it('mode:hard — external tool IS included in tools[] sent to LLM', async () => {
    const spy = makeSpyLlm();
    const { deps } = makeDefaultDeps({ llmResponses: [{ content: 'unused' }] });
    deps.mainLlm = spy;
    // mode is a SmartAgent config option, not a per-request option
    const agent = new SmartAgent(deps, { maxIterations: 5, mode: 'hard' });

    const result = await agent.process('do something', {
      externalTools: [EXTERNAL_TOOL],
      sessionId: 'test-hard-d4',
    });

    assert.ok(result.ok, 'request should succeed');
    assert.ok(
      spy.capturedTools.length > 0,
      'LLM streamChat should have been called at least once',
    );

    const firstCallTools = spy.capturedTools[0];
    const externalToolNames = firstCallTools.map((t) => t.name);
    assert.ok(
      externalToolNames.includes(EXTERNAL_TOOL.name),
      `External tool '${EXTERNAL_TOOL.name}' must be in tools[] in hard mode. Got: [${externalToolNames.join(', ')}]`,
    );
  });

  it('mode:smart — external tool IS included in tools[] sent to LLM (control)', async () => {
    const spy = makeSpyLlm();
    const { deps } = makeDefaultDeps({ llmResponses: [{ content: 'unused' }] });
    deps.mainLlm = spy;
    // mode:smart is the default, external tools should always be included
    const agent = new SmartAgent(deps, { maxIterations: 5, mode: 'smart' });

    const result = await agent.process('do something', {
      externalTools: [EXTERNAL_TOOL],
      sessionId: 'test-smart-d4',
    });

    assert.ok(result.ok, 'request should succeed');
    assert.ok(
      spy.capturedTools.length > 0,
      'LLM streamChat should have been called at least once',
    );

    const firstCallTools = spy.capturedTools[0];
    const externalToolNames = firstCallTools.map((t) => t.name);
    assert.ok(
      externalToolNames.includes(EXTERNAL_TOOL.name),
      `External tool '${EXTERNAL_TOOL.name}' must be in tools[] in smart mode. Got: [${externalToolNames.join(', ')}]`,
    );
  });
});
