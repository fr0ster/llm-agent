import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionRequestLogger } from '../session-request-logger.js';

test('a consumer MCP retrieval tool call is not counted as our tokens', () => {
  const log = new SessionRequestLogger();
  log.startRequest('r1');
  log.logToolCall({
    cached: false,
    durationMs: 5,
    requestId: 'r1',
    success: true,
    toolName: 'consumer_rag_search',
  });
  const s = log.getSummary('r1');
  assert.equal(s.toolCalls, 1);
  assert.equal(Object.keys(s.byComponent).length, 0); // no token attribution
});
