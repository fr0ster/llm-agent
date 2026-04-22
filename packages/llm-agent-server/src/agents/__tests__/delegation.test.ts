import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { LLMResponse } from '@mcp-abap-adt/llm-agent';
import { MCPClientWrapper } from '../../mcp/client.js';
import { AnthropicAgent } from '../anthropic-agent.js';
import { DeepSeekAgent } from '../deepseek-agent.js';
import { OpenAIAgent } from '../openai-agent.js';

const dummyMcp = new MCPClientWrapper({
  transport: 'embedded',
  listToolsHandler: async () => [],
});

const stubResponse: LLMResponse = {
  content: 'ok',
  finishReason: 'stop',
  raw: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] },
};

describe('Agent → Provider delegation', () => {
  it('OpenAIAgent.callLLMWithTools delegates to provider.chat()', async () => {
    const chatFn = mock.fn(async () => stubResponse);
    const provider = {
      chat: chatFn,
      streamChat: async function* () {},
      client: {},
      model: 'gpt-4o',
      config: {},
    };
    // @ts-expect-error — minimal stub
    const agent = new OpenAIAgent({
      llmProvider: provider,
      mcpClient: dummyMcp,
    });
    await agent.callWithTools([{ role: 'user', content: 'hi' }], []);

    assert.equal(chatFn.mock.callCount(), 1);
  });

  it('DeepSeekAgent.callLLMWithTools delegates to provider.chat()', async () => {
    const chatFn = mock.fn(async () => stubResponse);
    const provider = {
      chat: chatFn,
      streamChat: async function* () {},
      client: {},
      model: 'deepseek-chat',
      config: {},
    };
    // @ts-expect-error — minimal stub
    const agent = new DeepSeekAgent({
      llmProvider: provider,
      mcpClient: dummyMcp,
    });
    await agent.callWithTools([{ role: 'user', content: 'hi' }], []);

    assert.equal(chatFn.mock.callCount(), 1);
  });

  it('AnthropicAgent.callLLMWithTools delegates to provider.chat()', async () => {
    const chatFn = mock.fn(async () => ({
      content: 'ok',
      finishReason: 'end_turn',
      raw: { content: [{ type: 'text', text: 'ok' }] },
    }));
    const provider = {
      chat: chatFn,
      streamChat: async function* () {},
      client: {},
      model: 'claude-3-5-sonnet-20241022',
      config: {},
    };
    // @ts-expect-error — minimal stub
    const agent = new AnthropicAgent({
      llmProvider: provider,
      mcpClient: dummyMcp,
    });
    await agent.callWithTools([{ role: 'user', content: 'hi' }], []);

    assert.equal(chatFn.mock.callCount(), 1);
  });
});
