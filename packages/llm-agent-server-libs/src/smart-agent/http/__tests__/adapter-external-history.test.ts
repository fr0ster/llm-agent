import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  AnthropicApiAdapter,
  externalToolCallId,
  type Message,
  OpenAiApiAdapter,
} from '@mcp-abap-adt/llm-agent';
import { DefaultPipeline, SmartAgent } from '@mcp-abap-adt/llm-agent-libs';
import { makeDefaultDeps } from '@mcp-abap-adt/llm-agent-libs/testing';
import { ContextAssembler } from '../../../../../llm-agent-libs/src/context/context-assembler.js';
import { testHttpSession } from '../../__tests__/rag-identity-fixture.js';
import { handleAdapterRequest } from '../adapter-route-handler.js';

for (const stream of [false, true]) {
  test(`HTTP adapter reaches the model with completed external history (stream=${stream})`, async (t) => {
    const id = externalToolCallId('lookup', { query: 'original' });
    const body = {
      model: 'test',
      stream,
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ASSISTANT_HISTORY_SENTINEL' },
            {
              type: 'tool_use',
              id,
              name: 'lookup',
              input: { query: 'original' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              content: 'TOOL_HISTORY_SENTINEL',
            },
          ],
        },
        { role: 'user', content: 'continue' },
      ],
    };
    const adapter = new AnthropicApiAdapter();
    const expected = adapter.normalizeRequest(body).messages;
    const inputs: Message[][] = [];
    const { deps } = makeDefaultDeps();
    deps.mainLlm = {
      async chat() {
        assert.fail('pass mode uses streaming');
      },
      async *streamChat(messages) {
        inputs.push(
          structuredClone(
            messages.filter((message) => message.role !== 'system'),
          ),
        );
        yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
      },
    };
    const agent = new SmartAgent(deps, { mode: 'pass' });
    let cached: ReadonlyMap<string, string> | undefined;
    t.mock.method(
      agent,
      'streamProcess',
      (...args: Parameters<SmartAgent['streamProcess']>) => {
        cached = args[1]?.externalResults;
        return SmartAgent.prototype.streamProcess.apply(agent, args);
      },
    );
    const session = await testHttpSession();
    const server = createServer((req, res) => {
      void handleAdapterRequest(
        req,
        res,
        agent,
        adapter,
        session,
        undefined,
      ).catch((error) =>
        res.destroy(error instanceof Error ? error : undefined),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      assert.equal(response.status, 200);
      assert.match(await response.text(), /done/);
      assert.deepEqual(inputs, [expected]);
      assert.equal(cached?.get(id), 'TOOL_HISTORY_SENTINEL');
      assert.equal(inputs[0][1].content, 'ASSISTANT_HISTORY_SENTINEL');
      assert.equal(inputs[0][2].content, 'TOOL_HISTORY_SENTINEL');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });
}

for (const pipeline of [false, true, 'pass'] as const) {
  test(`OpenAI HTTP round trip isolates caller suspension and uses actual returned call IDs (${pipeline === 'pass' ? 'pass' : pipeline ? 'pipeline' : 'direct'})`, async () => {
    const inputs: Message[][] = [];
    const { deps } = makeDefaultDeps({
      assembler: new ContextAssembler({
        systemPromptPreamble: 'HOST_PREAMBLE',
      }),
    });
    deps.ragStores = {};
    deps.mainLlm = {
      async chat() {
        assert.fail('Streaming expected');
      },
      async *streamChat(messages) {
        inputs.push(messages);
        assert.ok(inputs.length <= 3);
        yield {
          ok: true,
          value:
            inputs.length === 1
              ? {
                  content: 'ASSISTANT',
                  toolCalls: [
                    {
                      index: 0,
                      id: 'model-id',
                      name: 'lookup',
                      arguments: '{ "query": "original" }',
                    },
                  ],
                  finishReason: 'tool_calls',
                }
              : { content: 'done', finishReason: 'stop' },
        };
      },
    };
    const config = {
      refreshToolsPerIteration: false,
      mode: pipeline === 'pass' ? ('pass' as const) : undefined,
    };
    if (pipeline === true) {
      const flow = new DefaultPipeline();
      flow.initialize({ ...deps, agentConfig: config });
      deps.pipeline = flow;
    }
    const agent = new SmartAgent(deps, config);
    const adapter = new OpenAiApiAdapter();
    const session = await testHttpSession();
    const server = createServer((req, res) => {
      void handleAdapterRequest(
        req,
        res,
        agent,
        adapter,
        req.headers['x-test-identity'] === 'anonymous'
          ? undefined
          : req.headers['x-test-identity'] === 'other-user'
            ? {
                ...session,
                caller: { ...session.caller, userId: 'other-user' },
              }
            : session,
        undefined,
      ).catch((error) =>
        res.destroy(error instanceof Error ? error : undefined),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
      const tools = [
        {
          type: 'function',
          function: { name: 'lookup', description: '', parameters: {} },
        },
      ];
      const initial: Message[] = [{ role: 'user', content: 'CONTINUE' }];
      const first = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: initial, tools }),
      });
      assert.equal(first.status, 200);
      const body = (await first.json()) as {
        choices: Array<{ message: Message; finish_reason: string }>;
      };
      assert.equal(body.choices[0].finish_reason, 'tool_calls');
      const returnedAssistant = body.choices[0].message;
      const id = returnedAssistant.tool_calls?.[0].id;
      assert.ok(id);
      assert.match(id, /^ext:[0-9a-f-]{36}:0$/);
      assert.notEqual(id, 'model-id');
      const cumulative: Message[] = [
        { role: 'system', content: 'CHANGED_SYSTEM' },
        ...initial,
        returnedAssistant,
        { role: 'tool', tool_call_id: id, content: 'NEW_RESULT' },
        { role: 'user', content: 'CONTINUE' },
      ];
      for (const identity of ['other-user', 'anonymous']) {
        const before = inputs.length;
        const attack: Awaited<ReturnType<typeof fetch>> = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-test-identity': identity,
          },
          body: JSON.stringify({
            model: 'test',
            messages: [
              { ...returnedAssistant, content: 'PUBLIC_ECHO' },
              { role: 'tool', tool_call_id: id, content: 'FORGED' },
            ],
            tools,
          }),
        });
        assert.equal(attack.status, identity === 'anonymous' ? 403 : 200);
        await attack.text();
        if (identity === 'anonymous') assert.equal(inputs.length, before);
        assert.doesNotMatch(
          JSON.stringify(inputs.at(-1)),
          /"content":"ASSISTANT"|NEW_RESULT/,
        );
      }
      const resumed = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: cumulative, tools }),
      });
      assert.equal(resumed.status, 200);
      assert.match(await resumed.text(), /done/);
      assert.equal(inputs.length, 3);
      assert.deepEqual(
        inputs[2].filter((message) => message.role !== 'system'),
        [
          ...initial,
          {
            role: 'assistant',
            content: 'ASSISTANT',
            tool_calls: [
              {
                id,
                type: 'function',
                function: {
                  name: 'lookup',
                  arguments: '{ "query": "original" }',
                },
              },
            ],
          },
          { role: 'tool', tool_call_id: id, content: 'NEW_RESULT' },
          { role: 'user', content: 'CONTINUE' },
        ],
      );
      assert.ok(
        inputs[2][0].content?.includes(
          pipeline === 'pass' ? 'CHANGED_SYSTEM' : 'HOST_PREAMBLE',
        ),
      );
      assert.equal(
        inputs[2].filter((message) => message.role === 'assistant').length,
        1,
      );
      assert.equal(
        inputs[2].filter((message) => message.role === 'tool').length,
        1,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });
}
