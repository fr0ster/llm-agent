import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  httpStatusOf,
  staticApiKey,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import {
  type AnthropicConfig,
  AnthropicProvider,
} from '../anthropic-provider.js';

function reply<T>(config: InternalAxiosRequestConfig, data: T) {
  return { config, data, status: 200, statusText: 'OK', headers: {} };
}

function notification() {
  let notify = () => {};
  const promise = new Promise<void>((resolve) => {
    notify = resolve;
  });
  return { notify, promise };
}

describe('AnthropicProvider getModels()', () => {
  it('includes only output token limits from the model list', async () => {
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
            {
              id: 'claude-sonnet-4-6',
              owned_by: 'anthropic',
              max_tokens: 64000,
              max_input_tokens: 1000000,
            },
            { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
            { id: 'another-model', max_tokens: 8192, max_input_tokens: null },
          ],
          has_more: false,
          first_id: 'claude-sonnet-4-6',
          last_id: 'another-model',
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    };

    assert.deepEqual(await provider.getModels(), [
      {
        id: 'claude-sonnet-4-6',
        owned_by: 'anthropic',
        maxOutputTokens: 64000,
      },
      { id: 'claude-opus-4-6', owned_by: undefined },
      { id: 'another-model', owned_by: undefined, maxOutputTokens: 8192 },
    ]);
    assert.equal(calls, 1);
  });

  it('shares one lookup across concurrent chat and stream calls per model', async (t) => {
    const provider = new AnthropicProvider({
      credential: staticApiKey('sk-test'),
      model: 'claude-opus-5-5',
    });
    const lookups: string[] = [];
    const requests: string[] = [];
    provider.client.defaults.adapter = async (config) => {
      const url = config.url ?? '';
      const model = url.slice('/models/'.length);
      if (config.method === 'get') lookups.push(model);
      else requests.push(String(config.data));
      return {
        data:
          config.method === 'get'
            ? {
                id: model,
                max_tokens: model === 'claude-opus-5-5' ? 128000 : 64000,
              }
            : { content: [], stop_reason: 'max_tokens' },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    };
    t.mock.method(
      globalThis,
      'fetch',
      async (_url: string, init: RequestInit) => {
        requests.push(String(init.body));
        return new Response(
          'event: message_delta\ndata: {"delta":{"stop_reason":"max_tokens"}}\n\nevent: message_stop\ndata: {}\n\n',
        );
      },
    );
    const collectStream = async () => {
      const chunks = [];
      for await (const chunk of provider.streamChat([])) chunks.push(chunk);
      return chunks;
    };
    const [chat, stream] = await Promise.all([
      provider.chat([]),
      collectStream(),
    ]);
    assert.equal(chat.finishReason, 'length');
    assert.equal(
      stream.find((chunk) => chunk.finishReason)?.finishReason,
      'length',
    );
    await provider.chat([], undefined, { model: 'other' });
    await provider.chat([], undefined, { model: 'other' });
    await provider.chat([], undefined, { model: 'override', maxTokens: 17 });
    assert.deepEqual(lookups, ['claude-opus-5-5', 'other']);
    assert.deepEqual(
      requests.map((body) => /"max_tokens":(\d+)/.exec(body)?.[1]),
      ['128000', '128000', '64000', '64000', '17'],
    );
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

describe('AnthropicProvider model discovery credentials', () => {
  it('isolates concurrent lookups and cached limits by effective key', async () => {
    const model = 'claude-test';
    let configuredKey = 'valid-key';
    const provider = new AnthropicProvider({
      credential: { kind: 'api-key', secret: async () => configuredKey },
      model,
    });
    const lookups: string[] = [];
    const posts: Array<[string, number]> = [];
    const badLookup = notification();
    const rejectBadLookup = notification();
    provider.client.defaults.adapter = async (config) => {
      const key = String(config.headers.get('x-api-key'));
      if (config.method === 'post') {
        posts.push([
          key,
          Number(/"max_tokens":(\d+)/.exec(String(config.data))?.[1]),
        ]);
        return reply(config, { content: [{ type: 'text', text: 'ok' }] });
      }
      lookups.push(key);
      if (key === 'bad-key') {
        badLookup.notify();
        await rejectBadLookup.promise;
        throw new AxiosError(key, 'ERR_BAD_REQUEST', config, undefined, {
          ...reply(config, { error: { message: key } }),
          status: 401,
        });
      }
      return reply(config, {
        id: 'canonical-model',
        max_tokens: key === 'valid-key' ? 4000 : 8000,
      });
    };

    const bad = provider.chat([], undefined, { apiKey: 'bad-key' });
    await badLookup.promise;
    const good = provider.chat([], undefined, { apiKey: 'valid-key' });
    const concurrent = Promise.allSettled([bad, good]);
    await setImmediate();
    rejectBadLookup.notify();
    const [rejected, accepted] = await concurrent;
    assert.equal(rejected.status, 'rejected');
    assert.ok(rejected.reason instanceof Error);
    assert.equal(httpStatusOf(rejected.reason), 401);
    assert.equal(rejected.reason.cause, undefined);
    assert.doesNotMatch(rejected.reason.message, /bad-key/);
    assert.equal(accepted.status, 'fulfilled');

    await provider.chat([], undefined, { model: 'canonical-model' });
    configuredKey = 'rotated-key';
    await provider.chat([]);
    await provider.chat([], undefined, { apiKey: 'valid-key' });
    assert.deepEqual(lookups, ['bad-key', 'valid-key', 'rotated-key']);
    assert.deepEqual(posts, [
      ['valid-key', 4000],
      ['valid-key', 4000],
      ['rotated-key', 8000],
      ['valid-key', 4000],
    ]);
  });

  it('uses list metadata only for the credential that fetched it', async () => {
    const model = 'claude-test';
    const provider = new AnthropicProvider({
      credential: staticApiKey('default-key'),
      model,
    });
    const requests: string[] = [];
    provider.client.defaults.adapter = async (config) => {
      const key = config.headers.get('x-api-key');
      requests.push(`${config.url}:${key}`);
      if (config.url === '/models')
        return reply(config, {
          data: [{ id: model, max_tokens: 4000 }],
          has_more: false,
        });
      if (config.url === `/models/${model}`)
        return reply(config, { id: model, max_tokens: 8000 });
      assert.match(
        String(config.data),
        key === 'list-key' ? /"max_tokens":4000/ : /"max_tokens":8000/,
      );
      return reply(config, { content: [] });
    };
    await provider.getModels({ apiKey: 'list-key' });
    await provider.chat([], undefined, { apiKey: 'list-key' });
    await provider.chat([]);
    assert.deepEqual(requests, [
      '/models:list-key',
      '/messages:list-key',
      `/models/${model}:default-key`,
      '/messages:default-key',
    ]);
  });
});

describe('AnthropicProvider model discovery throttling', () => {
  for (const limit of ['per-call', 'configured'] as const) {
    for (const mode of ['chat', 'stream'] as const) {
      it(`shares an active quota gate with a ${limit} limit in ${mode}`, async (t) => {
        const credential = staticApiKey('sk-test');
        const model = 'claude-test';
        const throttled = notification();
        const enteredGate = notification();
        const policy = new WaitAsTold();
        const config: AnthropicConfig = {
          credential,
          model,
          whenThrottled: {
            name: policy.name,
            decide(context) {
              if (context.source === 'response') {
                assert.equal(context.retryAfterSeconds, 60);
                throttled.notify();
              } else {
                enteredGate.notify();
              }
              return policy.decide(context);
            },
          },
        };
        const automatic = new AnthropicProvider(config);
        const explicit =
          limit === 'configured'
            ? new AnthropicProvider({ ...config, maxTokens: 100 })
            : automatic;
        let posts = 0;
        automatic.client.defaults.adapter = async (request) => {
          if (request.method === 'get')
            return reply(request, { id: model, max_tokens: 8000 });
          if (++posts === 1)
            throw Object.assign(new Error('Too many requests'), {
              response: { status: 429, headers: { 'Retry-After': '60' } },
            });
          assert.fail('request bypassed the quota gate');
        };
        explicit.client.defaults.adapter = automatic.client.defaults.adapter;
        if (mode === 'stream')
          t.mock.method(globalThis, 'fetch', () => {
            posts++;
            assert.fail('stream bypassed the quota gate');
          });

        const first = new AbortController();
        const second = new AbortController();
        const reason = new Error('caller canceled');
        const firstRejected = assert.rejects(
          automatic.chat([], undefined, { signal: first.signal }),
          (error) => error === reason,
        );
        try {
          await Promise.race([throttled.promise, firstRejected]);
          const options = {
            signal: second.signal,
            ...(limit === 'per-call' ? { maxTokens: 100 } : {}),
          };
          const request = (async () => {
            if (mode === 'chat') await explicit.chat([], undefined, options);
            else
              for await (const _chunk of explicit.streamChat(
                [],
                undefined,
                options,
              )) {
                // Drain the stream so the request reaches the quota gate.
              }
          })();
          try {
            await Promise.race([
              enteredGate.promise,
              request.then(() =>
                assert.fail('request bypassed the quota gate'),
              ),
            ]);
          } finally {
            second.abort(reason);
            await assert.rejects(request, (error) => error === reason);
          }
          assert.equal(posts, 1);
        } finally {
          first.abort(reason);
          await firstRejected;
        }
      });
    }
  }

  it('honors Retry-After: 0 until discovery succeeds and only then posts', async (t) => {
    const policy = new WaitAsTold({ fallbackBackoffMs: 0 });
    const decide = t.mock.method(policy, 'decide');
    const model = 'claude-test';
    const provider = new AnthropicProvider({
      credential: staticApiKey('sk-test'),
      model,
      whenThrottled: policy,
    });
    let gets = 0;
    let posts = 0;
    provider.client.defaults.adapter = async (config) => {
      if (config.method === 'get') {
        if (++gets <= 6) {
          throw Object.assign(new Error('Too many requests'), {
            response: { status: 429, headers: { 'Retry-After': '0' } },
          });
        }
        return reply(config, { id: model, max_tokens: 8000 });
      }
      posts++;
      assert.equal(gets, 7);
      return reply(config, { content: [{ type: 'text', text: 'ok' }] });
    };
    assert.equal((await provider.chat([])).content, 'ok');
    assert.equal(posts, 1);
    assert.deepEqual(
      decide.mock.calls.map(
        ({ arguments: [context] }) => context.retryAfterSeconds,
      ),
      [0, 0, 0, 0, 0, 0],
    );
  });

  it('cancels a discovery wait when the last caller aborts', async () => {
    const controller = new AbortController();
    const decided = notification();
    const policy = new WaitAsTold();
    const provider = new AnthropicProvider({
      credential: staticApiKey('sk-test'),
      model: 'claude-test',
      whenThrottled: {
        name: policy.name,
        decide(context) {
          assert.equal(context.retryAfterSeconds, 60);
          decided.notify();
          return policy.decide(context);
        },
      },
    });
    let requests = 0;
    provider.client.defaults.adapter = async (config) => {
      assert.equal(config.method, 'get');
      requests++;
      throw Object.assign(new Error('Too many requests'), {
        response: { status: 429, headers: { 'Retry-After': '60' } },
      });
    };
    const call = provider.chat([], undefined, { signal: controller.signal });
    const reason = new Error('caller canceled');
    const rejected = assert.rejects(call, (error) => error === reason);
    // A provider that skips the policy must fail the assertion without hanging.
    await Promise.race([decided.promise, rejected]);
    controller.abort(reason);
    await rejected;
    assert.equal(requests, 1);
  });
});
