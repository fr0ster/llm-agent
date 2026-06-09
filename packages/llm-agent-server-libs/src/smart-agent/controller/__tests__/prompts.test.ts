import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appendHint } from '../prompts.js';

describe('appendHint', () => {
  it('appends an Additional guidance preamble when a hint is given', () => {
    assert.equal(
      appendHint('SYS', 'call one tool at a time'),
      'SYS\n\nAdditional guidance: call one tool at a time',
    );
  });

  it('leaves the prompt untouched for an absent hint', () => {
    assert.equal(appendHint('SYS'), 'SYS');
    assert.equal(appendHint('SYS', undefined), 'SYS');
  });

  it('treats a blank/whitespace hint as absent', () => {
    assert.equal(appendHint('SYS', ''), 'SYS');
    assert.equal(appendHint('SYS', '   '), 'SYS');
  });

  it('trims the hint before appending', () => {
    assert.equal(appendHint('SYS', '  x  '), 'SYS\n\nAdditional guidance: x');
  });
});
