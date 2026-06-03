import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepStableArgsKey, externalToolCallId } from '../artifact-identity.js';

test('deepStableArgsKey: nested key order is canonical (same key)', () => {
  assert.equal(
    deepStableArgsKey({ filter: { a: 1, b: 2 } }),
    deepStableArgsKey({ filter: { b: 2, a: 1 } }),
  );
});
test('deepStableArgsKey: arrays preserve order (different key)', () => {
  assert.notEqual(
    deepStableArgsKey({ x: [1, 2] }),
    deepStableArgsKey({ x: [2, 1] }),
  );
});
test('externalToolCallId: case-distinct args → distinct id', () => {
  assert.notEqual(
    externalToolCallId('rag_add', { content: 'Hello' }),
    externalToolCallId('rag_add', { content: 'hello' }),
  );
});
test('externalToolCallId: same tool+args → same id; shape ext:<16hex>', () => {
  const id = externalToolCallId('rag_add', {
    collection: 'context',
    content: 'x',
  });
  assert.equal(
    id,
    externalToolCallId('rag_add', { collection: 'context', content: 'x' }),
  );
  assert.match(id, /^ext:[0-9a-f]{16}$/);
});
test('externalToolCallId: known vector pins the NUL separator (regression guard)', () => {
  // If the separator silently regresses to a space the hash changes → this fails.
  assert.equal(externalToolCallId('rag_add', { a: 1 }), 'ext:e99d19aab4a77c50');
});
