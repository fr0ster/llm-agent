import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import { createServerPipelineContext } from '../server-context.js';

const stubLlm = {
  chat: async () => ({}) as never,
  streamChat: async function* () {},
  model: 's',
} as never;

describe('createServerPipelineContext', () => {
  it('defaults toolsRag to an empty handle when omitted', async () => {
    const ctx = createServerPipelineContext({
      resolveLlm: async () => stubLlm,
      knowledgeRagFor: async () => ({}) as never,
      callMcp: async () => '',
      mintStepperId: () => 's',
      mintTurnId: () => 't',
      createAgentBuilder: async () =>
        new SmartAgentBuilder({}).withMainLlm(stubLlm),
      makeLlm: async () => stubLlm,
      mainLlm: stubLlm,
      mainTemp: 0,
      workerRegistry: new Map(),
      warn: () => {},
    });
    assert.deepEqual(await ctx.toolsRag.query('x'), []);
    assert.equal(ctx.toolsRag.lookup('x'), undefined);
    assert.equal(typeof ctx.mintTurnId(), 'string');
  });
});
