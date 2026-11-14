import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { AnthropicProvider } from '../anthropic-provider.js';

describe('AnthropicProvider getModels()', () => {
  it('returns a single page with the existing model info shape', async () => {
    const provider = new AnthropicProvider({
      credential: staticApiKey('sk-test'),
      model: 'claude-sonnet-4-6',
    });
    let calls = 0;
    provider.client.defaults.adapter = async (config) => {
      calls += 1;
      assert.equal(config.url, '/models');
      assert.deepEqual(config.params, { limit: 1000 });
      return {
        data: {
          data: [
            { id: 'claude-sonnet-4-6', owned_by: 'anthropic' },
            { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
          ],
          has_more: false,
          first_id: 'claude-sonnet-4-6',
          last_id: 'claude-opus-4-6',
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    };

    assert.deepEqual(await provider.getModels(), [
      { id: 'claude-sonnet-4-6', owned_by: 'anthropic' },
      { id: 'claude-opus-4-6', owned_by: undefined },
    ]);
    assert.equal(calls, 1);
  });

  it('collects all pages and passes each last_id as the next after_id', async () => {
    const provider = new AnthropicProvider({
      credential: staticApiKey('sk-test'),
      model: 'claude-sonnet-4-6',
    });
    let calls = 0;
    provider.client.defaults.adapter = async (config) => {
      calls += 1;
      assert.ok(calls <= 3, 'must stop when has_more is false');
      assert.equal(config.url, '/models');
      assert.deepEqual(
        config.params,
        calls === 1
          ? { limit: 1000 }
          : { limit: 1000, after_id: `model-${calls - 1}-last` },
      );
      return {
        data: {
          data: [{ id: `model-${calls}-first` }, { id: `model-${calls}-last` }],
          has_more: calls < 3,
          first_id: `model-${calls}-first`,
          last_id: `model-${calls}-last`,
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    };

    assert.deepEqual(
      await provider.getModels(),
      [
        'model-1-first',
        'model-1-last',
        'model-2-first',
        'model-2-last',
        'model-3-first',
        'model-3-last',
      ].map((id) => ({ id, owned_by: undefined })),
    );
    assert.equal(calls, 3);
  });

  it('resolves and sends the auth header on every page', async () => {
    let secretCalls = 0;
    const provider = new AnthropicProvider({
      credential: {
        kind: 'api-key',
        secret: async () => `sk-page-${++secretCalls}`,
      },
      model: 'claude-sonnet-4-6',
    });
    const headers: Array<string | undefined> = [];
    provider.client.defaults.adapter = async (config) => {
      headers.push(config.headers['x-api-key']);
      assert.ok(headers.length <= 2, 'must stop when has_more is false');
      return {
        data: {
          data: [{ id: `model-${headers.length}` }],
          has_more: headers.length === 1,
          first_id: `model-${headers.length}`,
          last_id: `model-${headers.length}`,
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    };

    await provider.getModels();
    assert.deepEqual(headers, ['sk-page-1', 'sk-page-2']);
    assert.equal(secretCalls, 2);
  });

  it('fails instead of re-reading the first page when has_more has no last_id', async () => {
    const provider = new AnthropicProvider({
      credential: staticApiKey('sk-test'),
      model: 'claude-sonnet-4-6',
    });
    let calls = 0;
    provider.client.defaults.adapter = async (config) => {
      calls += 1;
      return {
        data: {
          data: [{ id: 'model-1' }],
          has_more: true,
          first_id: 'model-1',
          last_id: null,
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    };

    await assert.rejects(provider.getModels(), /has_more without last_id/);
    assert.equal(calls, 1);
  });
});
