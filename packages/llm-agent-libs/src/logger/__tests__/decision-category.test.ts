import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATEGORY_MAP } from '../default-request-logger.js';

test('decision calls count as auxiliary tokens', () => {
  assert.equal(CATEGORY_MAP.decision, 'auxiliary');
});
