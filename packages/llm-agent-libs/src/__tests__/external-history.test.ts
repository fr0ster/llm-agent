import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildExternalResults,
  externalToolCallId,
  type Message,
} from '@mcp-abap-adt/llm-agent';
import { type AgentCallOptions, SmartAgent } from '../agent.js';
import { makeDefaultDeps, testCallOptions } from '../testing/index.js';

for (const stream of [false, true]) {
  test(`pass mode preserves completed external history (stream=${stream})`, async () => {
    const id = externalToolCallId('lookup', { query: 'original' });
    const history: Message[] = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: 'ASSISTANT_HISTORY_SENTINEL',
        tool_calls: [
          {
            id,
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"original"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: id, content: 'TOOL_HISTORY_SENTINEL' },
      { role: 'user', content: 'continue' },
    ];
    const snapshot = structuredClone(history);
    const { results, sanitizedMessages } = buildExternalResults(history);
    const { deps } = makeDefaultDeps();
    let modelCalls = 0;
    deps.mainLlm = {
      async chat() {
        assert.fail('pass mode uses streaming');
      },
      async *streamChat(messages) {
        modelCalls++;
        assert.deepEqual(
          messages.filter((message) => message.role !== 'system'),
          snapshot,
        );
        assert.equal(results.get(id), 'TOOL_HISTORY_SENTINEL');
        yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
      },
    };
    const agent = new SmartAgent(deps, { mode: 'pass' });
    const options: AgentCallOptions = {
      ...testCallOptions(),
      externalResults: results,
    };
    if (stream) {
      for await (const chunk of agent.streamProcess(sanitizedMessages, options))
        assert.ok(chunk.ok);
    } else {
      const result = await agent.process(sanitizedMessages, options);
      assert.ok(result.ok);
      assert.equal(result.value.content, 'done');
    }
    assert.equal(modelCalls, 1);
    assert.deepEqual(history, snapshot);
  });
}
