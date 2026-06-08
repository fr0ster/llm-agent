import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appendHint } from '../prompts.js';

describe('appendHint', () => {
  it('appends a Domain context preamble when a hint is given', () => {
    assert.equal(
      appendHint('SYS', 'live SAP system'),
      'SYS\n\nDomain context: live SAP system',
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
    assert.equal(appendHint('SYS', '  x  '), 'SYS\n\nDomain context: x');
  });
});
