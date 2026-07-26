import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeOfferedTools } from './merge-offered-tools.js';
import type { LlmTool } from './types.js';

const t = (name: string): LlmTool =>
  ({ name, description: '', inputSchema: {} }) as LlmTool;

describe('mergeOfferedTools', () => {
  it('concats when names are disjoint', () => {
    assert.deepEqual(
      mergeOfferedTools([t('primary__Search')], [t('web_fetch')]).map(
        (x) => x.name,
      ),
      ['primary__Search', 'web_fetch'],
    );
  });
  it('fail-fast when an external name equals a bare internal name', () => {
    assert.throws(
      () => mergeOfferedTools([t('Search')], [t('Search')]),
      /Search|both.*internal.*external/i,
    );
  });
  it('fail-fast when an external name equals a generated namespace', () => {
    assert.throws(
      () => mergeOfferedTools([t('s0__Search')], [t('s0__Search')]),
      /s0__Search/,
    );
  });
});
