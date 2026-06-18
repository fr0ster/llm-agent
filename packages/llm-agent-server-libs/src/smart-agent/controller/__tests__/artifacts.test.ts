import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deterministicId } from '../artifacts.js';

test('deterministicId is stable + order-sensitive + collision-resistant on segments', () => {
  assert.equal(
    deterministicId('run1', 'create'),
    deterministicId('run1', 'create'),
  );
  assert.notEqual(
    deterministicId('run1', 'create'),
    deterministicId('run1', 'replan'),
  );
  // segment boundary is unambiguous: ['a','bc'] !== ['ab','c']
  assert.notEqual(deterministicId('a', 'bc'), deterministicId('ab', 'c'));
});
