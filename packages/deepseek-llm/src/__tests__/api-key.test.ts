import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { DeepSeekProvider } from '../deepseek-provider.js';

test('uses the per-call key across chat, streaming and model discovery', async () => {
  const provider = new DeepSeekProvider({
    model: 'test-model',
    credential: staticApiKey('configured-key'),
  });
  const seen: string[] = [];
  provider.client.defaults.adapter = async (config) => {
    seen.push(String(config.headers.get('Authorization')));
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data:
        config.responseType === 'stream'
          ? Readable.from(['data: [DONE]\n'])
          : {
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              data: [],
            },
    };
  };
  const messages = [{ role: 'user', content: 'hello' }] satisfies Parameters<
    typeof provider.chat
  >[0];
  const override = { apiKey: 'call-key' };
  await Promise.all([
    provider.chat(messages, [], override),
    provider.chat(messages),
  ]);
  assert.deepEqual(seen.splice(0).sort(), [
    'Bearer call-key',
    'Bearer configured-key',
  ]);

  for (const options of [override, undefined]) {
    for await (const _chunk of provider.streamChat(messages, [], options)) {
      // Drain the stream.
    }
    await provider.getModels(options);
  }
  assert.deepEqual(seen, [
    'Bearer call-key',
    'Bearer call-key',
    'Bearer configured-key',
    'Bearer configured-key',
  ]);
  assert.equal(
    provider.client.defaults.headers.common.Authorization,
    undefined,
  );
});
