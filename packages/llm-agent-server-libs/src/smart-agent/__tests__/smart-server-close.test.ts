import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import { makeLlm } from '@mcp-abap-adt/llm-agent-libs/testing';
import { constructionSeams } from './construction-seams.js';
import { TestSmartServer } from './rag-identity-fixture.js';

for (const multiple of [false, true]) {
  test(`infra close runs every closer and preserves failures (multiple=${multiple})`, async (t) => {
    const calls: string[] = [];
    const first = new Error('agent close failed');
    const second = new Error('pool close failed');
    const build = SmartAgentBuilder.prototype.build;
    t.mock.method(
      SmartAgentBuilder.prototype,
      'build',
      async function (this: SmartAgentBuilder) {
        const result = await build.call(this);
        if (result.ok) {
          const close = result.value.close;
          result.value.close = async () => {
            await close();
            calls.push('agent');
            throw first;
          };
        }
        return result;
      },
    );
    const server = new TestSmartServer(
      { llm: { provider: 'ollama', model: 'stub' } },
      {
        ...constructionSeams,
        makeLlm: async () => makeLlm([{ content: 'ok' }]),
      },
    );
    const infra = await server['_buildInfra']();
    server['_skillPgPools'].push({
      end: async () => {
        calls.push('pool');
        if (multiple) throw second;
      },
    });
    const lifecycle = server['_lifecycle'];
    assert.ok(lifecycle);
    const dispose = lifecycle.disposeAll.bind(lifecycle);
    t.mock.method(lifecycle, 'disposeAll', async () => {
      calls.push('lifecycle');
      await dispose();
    });
    await assert.rejects(infra.close, (error) => {
      if (multiple) {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [first, second]);
      } else {
        assert.equal(error, first);
      }
      return true;
    });
    assert.deepEqual(calls, ['agent', 'pool', 'lifecycle']);
  });
}
