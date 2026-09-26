import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { MissingProviderError, staticApiKey } from '@mcp-abap-adt/llm-agent';
import {
  _resetPrefetchedForTests,
  prefetchEmbedderFactories,
} from '../embedder-factories.js';
import { resolveEmbedder } from '../rag-factories.js';

afterEach(() => {
  _resetPrefetchedForTests();
});

describe('embedder peers — MissingProviderError', () => {
  it('prefetch refuses a name that is not a built-in', async () => {
    await assert.rejects(
      () => prefetchEmbedderFactories(['does-not-exist']),
      MissingProviderError,
    );
  });

  it('resolving a built-in before its prefetch throws MissingProviderError', () => {
    assert.throws(
      () =>
        resolveEmbedder({
          provider: 'openai',
          model: 'text-embedding-3-small',
          credential: staticApiKey('test'),
        }),
      (err: unknown) => err instanceof MissingProviderError,
    );
  });

  it('prefetch loads the installed peer, and resolution then constructs it', async () => {
    await prefetchEmbedderFactories(['openai']);
    const e = resolveEmbedder({
      provider: 'openai',
      model: 'text-embedding-3-small',
      credential: staticApiKey('test'),
    });
    assert.equal(typeof e.embed, 'function');
  });
});
