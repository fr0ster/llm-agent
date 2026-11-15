import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ILlm,
  IMcpClient,
  LlmError,
  LlmStreamChunk,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { makeLlm } from '@mcp-abap-adt/llm-agent-libs/testing';
import { constructionSeams } from './construction-seams.js';
import { TestSmartServer } from './rag-identity-fixture.js';

interface ConfigResponse {
  models: { mainModel?: string };
  agent: { maxIterations?: number; maxToolCalls?: number };
}

async function startServer(maxIterations?: number) {
  let rounds = 0;
  let toolCalls = 0;
  const llm: ILlm = {
    ...makeLlm([]),
    model: 'test-model',
    async *streamChat(
      messages,
      tools,
    ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      rounds++;
      if (rounds > 12) {
        assert.ok(messages.some((message) => message.role === 'tool'));
        yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
      } else {
        assert.ok(
          tools?.length,
          'the real session agent must offer the MCP tool',
        );
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              {
                index: 0,
                id: `call-${rounds}`,
                name: tools[0].name,
                arguments: JSON.stringify({ round: rounds }),
              },
            ],
            finishReason: 'tool_calls',
          },
        };
      }
    },
  };
  const client: IMcpClient = {
    async listTools() {
      return {
        ok: true,
        value: [
          { name: 'Work', description: 'complete the work', inputSchema: {} },
        ],
      };
    },
    async callTool() {
      toolCalls++;
      return { ok: true, value: { content: 'completed' } };
    },
  };
  const server = new TestSmartServer(
    {
      port: 0,
      mode: 'hard',
      llm: { model: 'test-model' },
      skipModelValidation: true,
      rag: { store: { type: 'in-memory' } },
      agent: {
        maxIterations,
        maxToolCalls: maxIterations,
        classificationEnabled: false,
      },
      modelResolver: {
        async resolve() {
          return llm;
        },
      },
    },
    {
      ...constructionSeams,
      makeLlm: async () => llm,
      mcpClients: [client],
    },
  );
  const handle = await server.start();
  const base = `http://127.0.0.1:${handle.port}`;
  return { handle, base, rounds: () => rounds, toolCalls: () => toolCalls };
}

for (const mode of ['round-trip', 'null'] as const) {
  test(`config ${mode} preserves unlimited execution through the real chat route`, async () => {
    const run = await startServer(mode === 'null' ? 1 : undefined);
    try {
      const initial = await fetch(`${run.base}/v1/config`);
      assert.equal(initial.status, 200);
      const config = (await initial.json()) as ConfigResponse;
      if (mode === 'round-trip') {
        assert.equal('maxIterations' in config.agent, false);
        assert.equal('maxToolCalls' in config.agent, false);
      }
      const updated = await fetch(`${run.base}/v1/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          mode === 'round-trip'
            ? config
            : { agent: { maxIterations: null, maxToolCalls: null } },
        ),
      });
      assert.equal(updated.status, 200);
      const result = (await updated.json()) as ConfigResponse;
      assert.equal('maxIterations' in result.agent, false);
      assert.equal('maxToolCalls' in result.agent, false);
      const after = await fetch(`${run.base}/v1/config`);
      const stored = (await after.json()) as ConfigResponse;
      assert.equal('maxIterations' in stored.agent, false);
      assert.equal('maxToolCalls' in stored.agent, false);

      const chat = await fetch(`${run.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'complete the work' }],
          stream: false,
        }),
      });
      const output = await chat.text();
      assert.equal(chat.status, 200, output);
      assert.match(output, /done/);
      assert.equal(run.rounds(), 13);
      assert.equal(run.toolCalls(), 12);
    } finally {
      await run.handle.close();
    }
  });
}

test('PUT validates both loop limits atomically and accepts numeric strings', async () => {
  const run = await startServer(3);
  try {
    for (const field of ['maxIterations', 'maxToolCalls'] as const) {
      for (const value of [
        ...(field === 'maxIterations' ? [0, '0'] : []),
        -1,
        1.5,
        'abc',
        '',
        false,
        {},
        [],
      ]) {
        const response = await fetch(`${run.base}/v1/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: { maxIterations: 1, [field]: value } }),
        });
        const error = await response.text();
        assert.equal(response.status, 400, error);
        assert.match(error, new RegExp(`${field}.*integer`));
        const after = await fetch(`${run.base}/v1/config`);
        const stored = (await after.json()) as ConfigResponse;
        assert.equal(stored.agent.maxIterations, 3);
        assert.equal(stored.agent.maxToolCalls, 3);
      }
    }
    const updated = await fetch(`${run.base}/v1/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: { maxIterations: '2', maxToolCalls: '2' },
      }),
    });
    assert.equal(updated.status, 200);
    const config = (await updated.json()) as ConfigResponse;
    assert.equal(config.agent.maxIterations, 2);
    assert.equal(config.agent.maxToolCalls, 2);
    for (const value of [0, '0']) {
      const response = await fetch(`${run.base}/v1/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: { maxToolCalls: value } }),
      });
      assert.equal(response.status, 200);
      const result = (await response.json()) as ConfigResponse;
      assert.equal(result.agent.maxToolCalls, 0);
      const stored = (await (
        await fetch(`${run.base}/v1/config`)
      ).json()) as ConfigResponse;
      assert.equal(stored.agent.maxToolCalls, 0);
    }
  } finally {
    await run.handle.close();
  }
});
