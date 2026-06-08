import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('rag-query no longer logs embedding usage inline (wrapper owns it)', () => {
  const src = readFileSync(new URL('../rag-query.ts', import.meta.url), 'utf8');
  assert.equal(src.includes('embeddingUsageLogged'), false);
  assert.equal(/component:\s*'embedding'/.test(src), false);
});
