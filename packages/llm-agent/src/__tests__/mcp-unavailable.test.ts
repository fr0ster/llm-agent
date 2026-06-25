import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isMcpUnavailable,
  MCP_UNAVAILABLE_CODES,
  McpError,
} from '../interfaces/types.js';

test('isMcpUnavailable: availability codes are unavailable', () => {
  for (const code of MCP_UNAVAILABLE_CODES) {
    assert.equal(isMcpUnavailable(new McpError('x', code)), true, code);
  }
});

test('isMcpUnavailable: a plain tool error is NOT unavailable', () => {
  assert.equal(isMcpUnavailable(new McpError('bad args', 'MCP_ERROR')), false);
});

test('isMcpUnavailable: non-McpError is not unavailable', () => {
  assert.equal(isMcpUnavailable(new Error('whatever')), false);
  assert.equal(isMcpUnavailable(undefined), false);
});
