import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { escalateIfUnavailable } from '../escalate-if-unavailable.js';

test('throws on an availability error result', () => {
  const res = {
    ok: false as const,
    error: new McpError('Not connected', 'MCP_NOT_CONNECTED'),
  };
  assert.throws(() => escalateIfUnavailable(res), /Not connected/);
});

test('returns text for a tool-level error result', () => {
  const res = {
    ok: false as const,
    error: new McpError('bad args', 'MCP_ERROR'),
  };
  assert.equal(escalateIfUnavailable(res), 'bad args');
});

test('returns string content for an ok result', () => {
  const res = { ok: true as const, value: { content: 'hello' } };
  assert.equal(escalateIfUnavailable(res), 'hello');
});

test('JSON-stringifies non-string content for an ok result', () => {
  const res = { ok: true as const, value: { content: { rows: 3 } } };
  assert.equal(escalateIfUnavailable(res), '{"rows":3}');
});
