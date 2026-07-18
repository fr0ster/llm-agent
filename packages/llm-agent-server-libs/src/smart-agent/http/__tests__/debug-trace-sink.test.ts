import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { resolveTraceSink } from '../debug-trace-sink.js';

afterEach(() => {
  for (const v of ['DEBUG_LLM', 'DEBUG_MCP', 'DEBUG_TRACE_DIR'])
    delete process.env[v];
});

test('logDir wins → all areas, dir = logDir', () => {
  const r = resolveTraceSink('/var/log/app');
  assert.equal(r.dir, '/var/log/app');
  assert.equal(r.enabledAreas, 'all');
});

test('no logDir, DEBUG_LLM on → default trace dir, only {llm}', () => {
  process.env.DEBUG_LLM = '1';
  const r = resolveTraceSink(undefined);
  assert.equal(r.dir, './.smart-agent-debug/');
  assert.deepEqual([...(r.enabledAreas as Set<string>)], ['llm']);
});

test('DEBUG_TRACE_DIR overrides the default trace dir', () => {
  process.env.DEBUG_MCP = '1';
  process.env.DEBUG_TRACE_DIR = '/tmp/mytrace';
  const r = resolveTraceSink(undefined);
  assert.equal(r.dir, '/tmp/mytrace');
});

test('nothing set → dir null (no capture)', () => {
  const r = resolveTraceSink(undefined);
  assert.equal(r.dir, null);
});
