import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { NoopToolCache } from '../noop-tool-cache.js';
import { ToolCache } from '../tool-cache.js';

describe('ToolCache', () => {
  it('returns undefined on cache miss', () => {
    const cache = new ToolCache();
    const result = cache.get('tool1', { a: 1 });
    assert.equal(result, undefined);
  });

  it('returns cached result on hit', () => {
    const cache = new ToolCache();
    const mcpResult = { content: 'hello' };
    cache.set('tool1', { a: 1 }, mcpResult);
    const result = cache.get('tool1', { a: 1 });
    assert.deepEqual(result, mcpResult);
  });

  it('different args produce different keys', () => {
    const cache = new ToolCache();
    cache.set('tool1', { a: 1 }, { content: 'one' });
    cache.set('tool1', { a: 2 }, { content: 'two' });
    assert.deepEqual(cache.get('tool1', { a: 1 }), { content: 'one' });
    assert.deepEqual(cache.get('tool1', { a: 2 }), { content: 'two' });
  });

  it('same args in different order produce same key', () => {
    const cache = new ToolCache();
    cache.set('tool1', { b: 2, a: 1 }, { content: 'sorted' });
    const result = cache.get('tool1', { a: 1, b: 2 });
    assert.deepEqual(result, { content: 'sorted' });
  });

  it('returns undefined after TTL expires', () => {
    mock.timers.enable({ apis: ['Date'] });
    const cache = new ToolCache({ ttlMs: 1000 });
    cache.set('tool1', { a: 1 }, { content: 'data' });

    assert.deepEqual(cache.get('tool1', { a: 1 }), { content: 'data' });

    mock.timers.tick(1001);
    assert.equal(cache.get('tool1', { a: 1 }), undefined);
    mock.timers.reset();
  });

  it('clear() removes all entries', () => {
    const cache = new ToolCache();
    cache.set('tool1', { a: 1 }, { content: 'one' });
    cache.set('tool2', { b: 2 }, { content: 'two' });
    cache.clear();
    assert.equal(cache.get('tool1', { a: 1 }), undefined);
    assert.equal(cache.get('tool2', { b: 2 }), undefined);
  });

  it('defaults to 5 min TTL', () => {
    mock.timers.enable({ apis: ['Date'] });
    const cache = new ToolCache();
    cache.set('tool1', {}, { content: 'val' });

    mock.timers.tick(299_999);
    assert.deepEqual(cache.get('tool1', {}), { content: 'val' });

    mock.timers.tick(2);
    assert.equal(cache.get('tool1', {}), undefined);
    mock.timers.reset();
  });
});

describe('NoopToolCache', () => {
  it('always returns undefined', () => {
    const cache = new NoopToolCache();
    cache.set('tool1', { a: 1 }, { content: 'data' });
    assert.equal(cache.get('tool1', { a: 1 }), undefined);
  });

  it('clear() does not throw', () => {
    const cache = new NoopToolCache();
    cache.clear();
  });
});
