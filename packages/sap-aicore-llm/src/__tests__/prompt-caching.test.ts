// biome-ignore-all lint/complexity/useLiteralKeys: bracket access retains static types when inspecting private SDK boundaries in tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IUsageRecorder,
  Message,
  UsageInput,
} from '@mcp-abap-adt/llm-agent';
import {
  OrchestrationResponse,
  OrchestrationStream,
  OrchestrationStreamChunkResponse,
  OrchestrationStreamResponse,
} from '@sap-ai-sdk/orchestration';
import {
  type SapCoreAIConfig,
  SapCoreAIProvider,
} from '../sap-core-ai-provider.js';

const destination = {
  url: 'https://example.invalid',
  authentication: 'NoAuthentication' as const,
  headers: {},
};
const config = (
  model: string,
  promptCaching?: SapCoreAIConfig['promptCaching'],
): SapCoreAIConfig => ({
  model,
  promptCaching,
  apiBaseUrl: destination.url,
  credential: { kind: 'bearer', token: async () => 'test' },
});

for (const model of ['anthropic--claude-4-opus', 'claude-opus-4-7', 'gpt-4o']) {
  for (const mode of [undefined, 'off', 'system', 'system+tools'] as const) {
    test(`prompt caching: ${model}, ${mode ?? 'default'}`, () => {
      const provider = new SapCoreAIProvider(config(model, mode));
      const messages: Message[] = [
        { role: 'system', content: 'stable policy' },
        { role: 'user', content: 'variable request' },
      ];
      const tools = [
        {
          type: 'function',
          function: {
            name: 'read',
            description: 'Read',
            parameters: { type: 'object' },
          },
        },
      ];
      const before = structuredClone({ messages, tools });
      const client = provider['createClient'](
        provider['formatMessages'](messages),
        tools,
        destination,
      );
      const orch = client['config'];
      assert.ok(
        typeof orch === 'object' &&
          !Array.isArray(orch) &&
          'promptTemplating' in orch,
      );
      const prompt = orch.promptTemplating.prompt;
      assert.ok(prompt && typeof prompt === 'object' && 'template' in prompt);
      const enabled =
        model !== 'gpt-4o' && mode !== undefined && mode !== 'off';
      assert.equal(
        JSON.stringify(prompt.template).includes('cache_control'),
        enabled,
      );
      assert.equal(
        JSON.stringify(prompt.tools).includes('cache_control'),
        enabled && mode === 'system+tools',
      );
      assert.ok(
        !JSON.stringify(prompt.template?.[1]).includes('cache_control'),
      );
      assert.deepEqual({ messages, tools }, before);
    });
  }
}

test('formatting preserves message metadata', () => {
  const provider = new SapCoreAIProvider(config('claude-opus-4-7', 'system'));
  const input = [
    {
      role: 'system' as const,
      content: 'stable',
      metadata: { source: 'policy' },
    },
  ];
  assert.deepEqual(provider['formatMessages'](input), input);
});

for (const stream of [false, true]) {
  test(`normalizes cache read and creation usage, stream=${stream}`, async () => {
    const events: UsageInput[] = [];
    const recorder: IUsageRecorder = {
      record: (event) => {
        events.push(event);
      },
      with: () => recorder,
    };
    const provider = new SapCoreAIProvider({
      ...config('claude-opus-4-7', 'system'),
      usage: recorder,
    });
    const client = provider['createClient']([], [], destination);
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 7,
      total_tokens: 107,
      prompt_tokens_details: { cached_tokens: 60, cache_creation_tokens: 30 },
    };
    const result = {
      id: 'completion',
      object: 'chat.completion',
      created: 1,
      model: provider.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant' as const, content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage,
    };
    client.chatCompletion = async () =>
      new OrchestrationResponse({
        data: {
          request_id: 'request',
          intermediate_results: {},
          final_result: result,
        },
        headers: {},
        status: 200,
      });
    client.stream = async () => {
      const response =
        new OrchestrationStreamResponse<OrchestrationStreamChunkResponse>({
          data: {},
          headers: {},
          status: 200,
        });
      response.stream = new OrchestrationStream(async function* () {
        yield new OrchestrationStreamChunkResponse({
          request_id: 'request',
          final_result: {
            ...result,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
          },
        });
      }, new AbortController());
      return response;
    };
    provider['createClient'] = () => client;
    if (stream) {
      let sawUsage = false;
      for await (const chunk of provider.streamChat([
        { role: 'user', content: 'hello' },
      ])) {
        assert.equal(chunk.usage?.cachedInputTokens, 60);
        assert.equal(chunk.usage?.cacheCreationInputTokens, 30);
        sawUsage = true;
      }
      assert.ok(sawUsage);
    } else {
      const response = await provider.chat([
        { role: 'user', content: 'hello' },
      ]);
      assert.equal(response.usage?.cachedInputTokens, 60);
      assert.equal(response.usage?.cacheCreationInputTokens, 30);
    }
    const event = events.find((entry) => entry.kind === 'llm.call');
    assert.ok(event?.kind === 'llm.call');
    assert.equal(event.cachedInputTokens, 60);
    assert.equal(event.cacheCreationInputTokens, 30);
  });
}
