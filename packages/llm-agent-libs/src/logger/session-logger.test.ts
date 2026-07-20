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

/*
 * Path-traversal containment.
 *
 * `name` reaches SessionLogger from model-controlled text: tool-loop-core
 * logs `mcp_call_${tc.name}` BEFORE resolving `tc.name` against the client
 * map, so a hallucinated or injected tool name never has to match a real
 * tool to land in a filesystem path. `sessionId`/`traceId` are likewise
 * request-derived. Containment belongs here, at the sink, not at the N
 * call sites that build these strings.
 */

test('logStep with a traversing name writes inside the request dir, not outside', () => {
  const outside = path.join(dir, 'ESCAPED.json');
  const log = new SessionLogger(dir, 'sid', 'tid', new Set(['mcp']));
  log.logStep('mcp_call_../../../ESCAPED', { a: 1 }, 'mcp');

  assert.equal(fs.existsSync(outside), false, 'must not escape request dir');
  const files = stepFiles(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /\.json$/);
  assert.equal(
    files[0].includes('..'),
    false,
    'traversal segments must be stripped from the file name',
  );
});

test('logStep name containing separators/NUL is flattened, still written', () => {
  const log = new SessionLogger(dir, 'sid', 'tid', new Set(['mcp']));
  log.logStep('mcp_result_a/b\\c', { a: 1 }, 'mcp');
  const files = stepFiles(dir);
  assert.equal(files.length, 1);
  assert.equal(/[/\\]/.test(files[0]), false);
});

test('traversing sessionId/traceId cannot place the request dir outside base', () => {
  const log = new SessionLogger(
    dir,
    '../../evil',
    '../../tid',
    new Set(['llm']),
  );
  log.logStep('llm_request', { a: 1 }, 'llm');

  assert.equal(fs.existsSync(path.join(dir, '..', '..', 'evil')), false);
  const entries = fs.readdirSync(dir);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^session_/);
  assert.equal(stepFiles(dir).length, 1);
});
