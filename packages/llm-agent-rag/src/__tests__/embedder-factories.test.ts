import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { MissingProviderError, staticApiKey } from '@mcp-abap-adt/llm-agent';
import {
  _resetPrefetchedForTests,
  prefetchEmbedderFactories,
  resolvePrefetchedEmbedder,
} from '../embedder-factories.js';

afterEach(() => {
  _resetPrefetchedForTests();
});

describe('factory registry — MissingProviderError', () => {
  it('resolvePrefetchedEmbedder throws MissingProviderError for unknown factory name', () => {
    assert.throws(
      () => resolvePrefetchedEmbedder('does-not-exist', {}),
      (err: unknown) => err instanceof MissingProviderError,
    );
  });
  it('resolvePrefetchedEmbedder throws before prefetch', () => {
    assert.throws(
      () => resolvePrefetchedEmbedder('openai', {}),
      (err: unknown) => err instanceof MissingProviderError,
    );
  });
  it('prefetchEmbedderFactories resolves installed peer', async () => {
    await prefetchEmbedderFactories(['openai']);
    // Task B4 replaced OpenAiEmbedder's `apiKey: string` with a required
    // `credential`. This options bag is `Record<string, unknown>` (B6a owns
    // typing it), so an untyped `credential` still reaches the constructor
    // and works at runtime.
    const e = resolvePrefetchedEmbedder('openai', {
      credential: staticApiKey('test'),
      model: 'text-embedding-3-small',
    });
    assert.ok(e);
  });
});
