import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IUsageRecorder, UsageInput } from '@mcp-abap-adt/llm-agent';
import { SapCoreAIProvider } from '../sap-core-ai-provider.js';

test('response processing errors count once; rejected credentials never count for chat or stream', async () => {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (r) => records.push(r),
    with: () => usage,
  };
  let rejectCredential = false;
  let rejectSetup = false;
  let requests = 0;
  const provider = new SapCoreAIProvider({
    model: 'test',
    usage,
    apiBaseUrl: 'https://example.invalid',
    credential: {
      kind: 'bearer' as const,
      token: async () => {
        if (rejectCredential) throw new Error('credential rejected');
        return 'secret';
      },
    },
  });
  Object.assign(provider, {
    createClient: () => {
      if (rejectSetup) throw new Error('setup rejected');
      return {
        chatCompletion: async () => {
          requests++;
          return {
            getContent: () => {
              throw new Error('unusable content');
            },
            getToolCalls: () => undefined,
          };
        },
      };
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
  rejectCredential = false;
  rejectSetup = true;
  await assert.rejects(provider.chat([]), /setup rejected/);
  await assert.rejects(async () => {
    for await (const _ of provider.streamChat([])) {
      /* consume */
    }
  }, /setup rejected/);
  assert.equal(records.length, 0);
});
