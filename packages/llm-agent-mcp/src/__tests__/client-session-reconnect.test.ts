import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCPClientWrapper } from '../client.js';

test('reconnect prefers the live server-assigned sessionId over config', () => {
  const w = new MCPClientWrapper({
    transport: 'stream-http',
    url: 'http://localhost:9/mcp',
  });
  // Simulate a prior successful connect that captured a server session id.
  (w as unknown as { sessionId?: string }).sessionId = 'live-session-123';
  const used = (
    w as unknown as { _sessionForConnect(): string | undefined }
  )._sessionForConnect();
  assert.equal(used, 'live-session-123');
});

test('falls back to the configured sessionId when no live session yet', () => {
  const w = new MCPClientWrapper({
    transport: 'stream-http',
    url: 'http://localhost:9/mcp',
    sessionId: 'config-session',
  });
  const used = (
    w as unknown as { _sessionForConnect(): string | undefined }
  )._sessionForConnect();
  assert.equal(used, 'config-session');
});
