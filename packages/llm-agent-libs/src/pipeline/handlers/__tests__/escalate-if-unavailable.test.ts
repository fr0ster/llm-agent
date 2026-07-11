import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type IMcpFailureClassifier, McpError } from '@mcp-abap-adt/llm-agent';
import { classifyToolResult } from '../escalate-if-unavailable.js';

// ── Existing tests (updated to await) ────────────────────────────────────────

test('classify: availability error → escalate', async () => {
  const d = await classifyToolResult({
    ok: false,
    error: new McpError('Not connected', 'MCP_NOT_CONNECTED'),
  });
  assert.ok(d.escalate, 'must escalate');
  assert.equal(d.escalate?.message, 'Not connected');
});

test('classify: tool-level error → text (LLM feedback)', async () => {
  const d = await classifyToolResult({
    ok: false,
    error: new McpError('bad args', 'MCP_ERROR'),
  });
  assert.equal(d.escalate, undefined);
  assert.equal(d.text, 'bad args');
});

test('classify: ok string content → text', async () => {
  const d = await classifyToolResult({ ok: true, value: { content: 'hello' } });
  assert.equal(d.escalate, undefined);
  assert.equal(d.text, 'hello');
});

test('classify: ok non-string content → JSON text', async () => {
  const d = await classifyToolResult({
    ok: true,
    value: { content: { rows: 3 } },
  });
  assert.equal(d.text, '{"rows":3}');
});

// ── New tests — custom classifier ─────────────────────────────────────────────

test('classify: custom classifier returning unavailable for MCP_ERROR → escalates', async () => {
  const custom: IMcpFailureClassifier = {
    classify: async (_err, _probe) => 'unavailable',
  };
  const d = await classifyToolResult(
    { ok: false, error: new McpError('boom', 'MCP_ERROR') },
    custom,
  );
  assert.ok(d.escalate, 'custom classifier must escalate MCP_ERROR');
  assert.equal(d.escalate?.message, 'boom');
});

test('classify: default classifier + MCP_ERROR → NOT escalated (unchanged behavior)', async () => {
  const d = await classifyToolResult({
    ok: false,
    error: new McpError('bad args', 'MCP_ERROR'),
  });
  assert.equal(d.escalate, undefined, 'default must NOT escalate MCP_ERROR');
});

test('classify: default classifier + MCP_NOT_CONNECTED → escalates', async () => {
  const d = await classifyToolResult({
    ok: false,
    error: new McpError('Not connected', 'MCP_NOT_CONNECTED'),
  });
  assert.ok(d.escalate, 'default must escalate MCP_NOT_CONNECTED');
});

// ── Probe passthrough ─────────────────────────────────────────────────────────

test('classify: probe passthrough — escalates when probeHealth resolves false', async () => {
  const custom: IMcpFailureClassifier = {
    classify: async (_err, probeHealth) => {
      if (probeHealth && !(await probeHealth())) return 'unavailable';
      return 'tool-error';
    },
  };
  const d = await classifyToolResult(
    { ok: false, error: new McpError('unreachable', 'MCP_ERROR') },
    custom,
    async () => false,
  );
  assert.ok(d.escalate, 'must escalate when probe returns false');
});

test('classify: probe passthrough — does NOT escalate when probeHealth resolves true', async () => {
  const custom: IMcpFailureClassifier = {
    classify: async (_err, probeHealth) => {
      if (probeHealth && !(await probeHealth())) return 'unavailable';
      return 'tool-error';
    },
  };
  const d = await classifyToolResult(
    { ok: false, error: new McpError('unreachable', 'MCP_ERROR') },
    custom,
    async () => true,
  );
  assert.equal(
    d.escalate,
    undefined,
    'must NOT escalate when probe returns true',
  );
  assert.equal(d.text, 'unreachable');
});
