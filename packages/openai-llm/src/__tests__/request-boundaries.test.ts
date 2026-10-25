import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IUsageRecorder, UsageInput } from '@mcp-abap-adt/llm-agent';
import { OpenAIProvider } from '../openai-provider.js';

test('response processing errors count once; rejected credentials never count for chat or stream', async () => {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (r) => records.push(r),
    with: () => usage,
  };
  let rejectCredential = false;

  let requests = 0;
  const provider = new OpenAIProvider({
    model: 'test',
    usage,
    credential: {
      kind: 'api-key' as const,
      secret: async () => {
        if (rejectCredential) throw new Error('credential rejected');
        return 'secret';
      },
    },
  });
  Object.defineProperty(provider.client, 'post', {
    value: async () => {
      requests++;
      return { status: 200, data: { choices: [] } };
    },
  });
  await assert.rejects(provider.chat([]));
  assert.equal(requests, 1);
  assert.deepEqual(
    records.map((r) => r.outcome),
    ['error'],
  );
  records.length = 0;
  rejectCredential = true;
  await assert.rejects(provider.chat([]), /credential rejected/);
  await assert.rejects(async () => {
    for await (const _ of provider.streamChat([])) {
      /* consume */
    }
  }, /credential rejected/);
  assert.equal(requests, 1);
  assert.equal(records.length, 0);
});
