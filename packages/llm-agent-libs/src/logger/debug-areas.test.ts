import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DEBUG_ENV, enabledAreasFromEnv, isDebugArea } from './debug-areas.js';

const VARS = ['DEBUG_LLM', 'DEBUG_CONTROLLER', 'DEBUG_MCP', 'DEBUG_RAG'];
afterEach(() => {
  for (const v of VARS) delete process.env[v];
});

test('registry maps every area to its DEBUG_ env var', () => {
  assert.deepEqual(DEBUG_ENV, {
    llm: 'DEBUG_LLM',
    controller: 'DEBUG_CONTROLLER',
    mcp: 'DEBUG_MCP',
    rag: 'DEBUG_RAG',
  });
});

test('isDebugArea reads the env var (set / unset / arbitrary truthy)', () => {
  assert.equal(isDebugArea('llm'), false);
  process.env.DEBUG_LLM = '1';
  assert.equal(isDebugArea('llm'), true);
  process.env.DEBUG_LLM = 'yes';
  assert.equal(isDebugArea('llm'), true);
  process.env.DEBUG_LLM = '';
  assert.equal(isDebugArea('llm'), false);
});

test('enabledAreasFromEnv collects exactly the on-flags', () => {
  assert.deepEqual([...enabledAreasFromEnv()], []);
  process.env.DEBUG_LLM = '1';
  process.env.DEBUG_MCP = '1';
  assert.deepEqual([...enabledAreasFromEnv()].sort(), ['llm', 'mcp']);
});
