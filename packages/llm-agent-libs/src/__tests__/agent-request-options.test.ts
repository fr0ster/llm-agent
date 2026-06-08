import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IRequestLogger } from '@mcp-abap-adt/llm-agent';
import { normalizeRequestOptions } from '../agent-request-options.js';

const logger = {} as IRequestLogger;

test('writes generated traceId when options have no trace', () => {
  const out = normalizeRequestOptions(undefined, 'gen-1', logger);
  assert.equal(out.trace?.traceId, 'gen-1');
  assert.equal(out.requestLogger, logger);
});

test('preserves an existing traceId and other trace fields', () => {
  const out = normalizeRequestOptions(
    { trace: { traceId: 'given', spanId: 's1' }, signal: undefined },
    'given',
    logger,
  );
  assert.equal(out.trace?.traceId, 'given');
  assert.equal(out.trace?.spanId, 's1');
});

test('does not overwrite a caller-supplied requestLogger', () => {
  const other = {} as IRequestLogger;
  const out = normalizeRequestOptions({ requestLogger: other }, 'gen-2', logger);
  assert.equal(out.requestLogger, other);
});
