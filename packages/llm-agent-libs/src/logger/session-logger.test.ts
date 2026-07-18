import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { SessionLogger } from './session-logger.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sesslog-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function stepFiles(base: string): string[] {
  const sess = fs.readdirSync(base).find((d) => d.startsWith('session_'));
  if (!sess) return [];
  const reqRoot = path.join(base, sess);
  const req = fs.readdirSync(reqRoot).find((d) => d.startsWith('req_'));
  if (!req) return [];
  return fs.readdirSync(path.join(reqRoot, req));
}

test('all-areas (legacy logDir): every tagged AND untagged step writes', () => {
  const log = new SessionLogger(dir, 'sid', 'tid', 'all');
  log.logStep('untagged', { a: 1 });
  log.logStep('tagged_llm', { a: 2 }, 'llm');
  const files = stepFiles(dir);
  assert.equal(files.length, 2);
});

test('granular (only llm): llm writes, mcp and untagged do NOT', () => {
  const log = new SessionLogger(dir, 'sid', 'tid', new Set(['llm']));
  log.logStep('r_llm', { a: 1 }, 'llm');
  log.logStep('r_mcp', { a: 2 }, 'mcp');
  log.logStep('r_untagged', { a: 3 }); // general sentinel → off
  const files = stepFiles(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /_r_llm\.json$/);
});

test('empty enabled set: no dir, no writes', () => {
  const log = new SessionLogger(dir, 'sid', 'tid', new Set());
  log.logStep('x', {}, 'llm');
  assert.deepEqual(stepFiles(dir), []);
});

test('default enabledAreas is "all" (backward-compat, 3-arg ctor)', () => {
  const log = new SessionLogger(dir, 'sid', 'tid');
  log.logStep('legacy', { a: 1 });
  assert.equal(stepFiles(dir).length, 1);
});
