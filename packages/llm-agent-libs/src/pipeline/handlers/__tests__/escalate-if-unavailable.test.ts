import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { classifyToolResult } from '../escalate-if-unavailable.js';

test('classify: availability error → escalate', () => {
  const d = classifyToolResult({
    ok: false,
    error: new McpError('Not connected', 'MCP_NOT_CONNECTED'),
  });
  assert.ok(d.escalate, 'must escalate');
  assert.equal(d.escalate?.message, 'Not connected');
});

test('classify: tool-level error → text (LLM feedback)', () => {
  const d = classifyToolResult({
    ok: false,
    error: new McpError('bad args', 'MCP_ERROR'),
  });
  assert.equal(d.escalate, undefined);
  assert.equal(d.text, 'bad args');
});

test('classify: ok string content → text', () => {
  const d = classifyToolResult({ ok: true, value: { content: 'hello' } });
  assert.equal(d.escalate, undefined);
  assert.equal(d.text, 'hello');
});

test('classify: ok non-string content → JSON text', () => {
  const d = classifyToolResult({ ok: true, value: { content: { rows: 3 } } });
  assert.equal(d.text, '{"rows":3}');
});
