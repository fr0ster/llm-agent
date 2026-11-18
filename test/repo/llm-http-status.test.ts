import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeepSeekProvider } from '@mcp-abap-adt/deepseek-llm';
import {
  httpStatusOf,
  type LlmError,
  type LlmResponse,
  type LlmStreamChunk,
  type Result,
  staticApiKey,
} from '@mcp-abap-adt/llm-agent';
import {
  LlmAdapter,
  LlmProviderBridge,
  RetryLlm,
} from '@mcp-abap-adt/llm-agent-libs';
import { OllamaProvider } from '@mcp-abap-adt/ollama-llm';
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';

for (const Provider of [OpenAIProvider, DeepSeekProvider, OllamaProvider]) {
  for (const stream of [false, true]) {
    test(`${Provider.name} preserves HTTP 400 through the bridge and retry, stream=${stream}`, async () => {
      const provider = new Provider({
        credential: staticApiKey('test-key'),
        model: 'test-model',
      });
      let calls = 0;
      provider.client.defaults.adapter = async (config) => {
        assert.equal(++calls, 1, 'a permanent HTTP error cannot be retried');
        throw Object.assign(new Error('Bad request'), {
          isAxiosError: true,
          config,
          response: {
            status: 400,
            data: { error: { message: 'max_tokens must be at most 500' } },
          },
        });
      };
      const llm = new RetryLlm(
        new LlmAdapter(new LlmProviderBridge(provider)),
        {
          backoffMs: 0,
        },
      );
      const results: Result<LlmResponse | LlmStreamChunk, LlmError>[] = [];
      if (stream) {
        for await (const result of llm.streamChat([])) results.push(result);
      } else results.push(await llm.chat([]));
      assert.equal(calls, 1);
      assert.equal(results.length, 1);
      assert.ok(!results[0].ok);
      assert.match(results[0].error.message, /max_tokens must be at most 500/);
      assert.equal(httpStatusOf(results[0].error), 400);
    });
  }
}
