import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMcpUnavailable } from '@mcp-abap-adt/llm-agent';
import { MCPClientWrapper } from '../client.js';
import { toMcpError } from '../error-mapping.js';

/** Build a Node-`fetch`-style error: top message "fetch failed", real cause nested. */
function fetchFailed(causeMessage: string, code?: string): Error {
  const cause = new Error(causeMessage);
  if (code) (cause as { code?: string }).code = code;
  return new TypeError('fetch failed', { cause });
}

const UNAVAILABLE_CASES: Array<[string, unknown]> = [
  [
    'fetch failed → ECONNREFUSED',
    fetchFailed('connect ECONNREFUSED 127.0.0.1:7779', 'ECONNREFUSED'),
  ],
  [
    'fetch failed → ENOTFOUND',
    fetchFailed('getaddrinfo ENOTFOUND host.invalid', 'ENOTFOUND'),
  ],
  ['fetch failed → ECONNRESET', fetchFailed('read ECONNRESET', 'ECONNRESET')],
  [
    'fetch failed → EHOSTUNREACH',
    fetchFailed('connect EHOSTUNREACH', 'EHOSTUNREACH'),
  ],
  ['plain connection refused', new Error('connection refused')],
  ['Not connected', new Error('Not connected')],
  ['-32001 timeout', new Error('MCP error -32001: Request timed out')],
  ['HTTP 502', new Error('502 Bad Gateway')],
  [
    'no response after reconnect',
    new Error('boom (no response after reconnect)'),
  ],
  [
    'Streamable HTTP error: 404 route-gone',
    new Error(
      'Streamable HTTP error: Error POSTing to endpoint: 404 Not Found: Requested route /mcp does not exist.',
    ),
  ],
];

for (const [label, err] of UNAVAILABLE_CASES) {
  test(`toMcpError: ${label} → unavailable`, () => {
    assert.equal(isMcpUnavailable(toMcpError(err)), true, label);
  });
}

test('toMcpError: a plain tool error stays MCP_ERROR (not unavailable)', () => {
  assert.equal(
    isMcpUnavailable(toMcpError(new Error('tool execution failed'))),
    false,
  );
  assert.equal(isMcpUnavailable(toMcpError('field X is required')), false);
});

// Negative cases — SAP/ABAP domain errors that contain transport/network words
// must NOT be classified as MCP outages (review: bare-substring false positives).
const DOMAIN_NOT_OUTAGE = [
  'Transport request ZDEVK900123 not found',
  'transport request is not released',
  'Business network id is invalid',
  'Network profile NETPROF does not exist',
  'Object 503 in package not found', // bare number must not match HTTP 503
  'Table T502 read error', // bare 502 must not match HTTP 502
];
for (const msg of DOMAIN_NOT_OUTAGE) {
  test(`toMcpError: domain error "${msg.slice(0, 28)}…" stays MCP_ERROR`, () => {
    const mapped = toMcpError(new Error(msg));
    assert.equal(mapped.code, 'MCP_ERROR', `${msg} → ${mapped.code}`);
    assert.equal(isMcpUnavailable(mapped), false);
  });
}

test('integration: a real down HTTP endpoint maps to unavailable', async () => {
  const w = new MCPClientWrapper({
    transport: 'stream-http',
    url: 'http://127.0.0.1:7779/mcp',
    timeout: 2000,
  });
  let mapped: unknown;
  try {
    await w.connect();
    assert.fail('expected connect() to fail against a closed port');
  } catch (e) {
    mapped = toMcpError(e);
  }
  assert.equal(isMcpUnavailable(mapped), true);
});
