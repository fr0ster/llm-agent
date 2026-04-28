import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  HistoryTurn,
  ILlm,
  LlmError,
  LlmResponse,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { HistorySummarizer } from '../history-summarizer.js';

function makeFakeLlm(response: string): ILlm {
  return {
    model: 'test',
    chat: async (): Promise<Result<LlmResponse, LlmError>> => ({
      ok: true,
      value: { content: response, finishReason: 'stop' },
    }),
    streamChat: async function* () {},
  };
}

function makeFakeLlmError(message: string): ILlm {
  return {
    model: 'test',
    chat: async (): Promise<Result<LlmResponse, LlmError>> => ({
      ok: false,
      error: { message, code: 'LLM_ERROR' } as LlmError,
    }),
    streamChat: async function* () {},
  };
}

const TURN: HistoryTurn = {
  sessionId: 's1',
  turnIndex: 0,
  userText: 'Create class ZCL_TEST',
  assistantText: 'I created the class ZCL_TEST in package ZDEV.',
  toolCalls: [{ name: 'createClass', arguments: { className: 'ZCL_TEST' } }],
  toolResults: [
    { tool: 'createClass', content: 'Class ZCL_TEST created successfully' },
  ],
  timestamp: Date.now(),
};

describe('HistorySummarizer', () => {
  it('returns LLM summary on success', async () => {
    const llm = makeFakeLlm(
      'User asked to create class ZCL_TEST -> Created in package ZDEV',
    );
    const summarizer = new HistorySummarizer(llm);
    const result = await summarizer.summarize(TURN);
    assert.ok(result.ok);
    assert.equal(
      result.value,
      'User asked to create class ZCL_TEST -> Created in package ZDEV',
    );
  });

  it('passes turn context in user message', async () => {
    let capturedMessages: unknown[] = [];
    const llm: ILlm = {
      model: 'test',
      chat: async (messages) => {
        capturedMessages = messages;
        return {
          ok: true,
          value: { content: 'summary', finishReason: 'stop' as const },
        };
      },
      streamChat: async function* () {},
    };
    const summarizer = new HistorySummarizer(llm);
    await summarizer.summarize(TURN);
    assert.ok(capturedMessages.length >= 2);
    const userMsg = capturedMessages[capturedMessages.length - 1] as {
      content: string;
    };
    assert.ok(userMsg.content.includes('ZCL_TEST'));
    assert.ok(userMsg.content.includes('createClass'));
  });

  it('uses custom prompt when provided', async () => {
    let capturedMessages: unknown[] = [];
    const llm: ILlm = {
      model: 'test',
      chat: async (messages) => {
        capturedMessages = messages;
        return {
          ok: true,
          value: { content: 'summary', finishReason: 'stop' as const },
        };
      },
      streamChat: async function* () {},
    };
    const summarizer = new HistorySummarizer(llm, {
      prompt: 'Custom prompt here',
    });
    await summarizer.summarize(TURN);
    const sysMsg = capturedMessages[0] as { content: string };
    assert.ok(sysMsg.content.includes('Custom prompt here'));
  });

  it('propagates LLM error', async () => {
    const llm = makeFakeLlmError('model overloaded');
    const summarizer = new HistorySummarizer(llm);
    const result = await summarizer.summarize(TURN);
    assert.ok(!result.ok);
    assert.ok(result.error.message.includes('model overloaded'));
  });
});
