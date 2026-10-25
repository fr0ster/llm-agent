import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IUsageRecorder, UsageInput } from '../../interfaces/usage.js';
import {
  beginEmbeddingRequest,
  beginLlmRequest,
  noopUsageRecorder,
  resolveRecorder,
  startOperation,
  withChunk,
  withOuterAttempt,
  withProviderAttempt,
} from '../hooks.js';

function recorder() {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record(input) {
      records.push(input);
    },
    with() {
      return usage;
    },
  };
  return { usage, records };
}
const base = {
  provider: 'test',
  model: 'model',
  stream: true,
  granularity: 'request' as const,
  retriesVisible: true,
};

test('operations reuse caller metadata and compose immutable coordinates with a shared sequence', () => {
  const op = startOperation();
  assert.equal(startOperation({ usageOp: op }), op);
  assert.notEqual(startOperation().operationId, op.operationId);
  const copy = withProviderAttempt(
    withOuterAttempt(withChunk(withChunk(op, 1, 3), 0, 4), 2),
    1,
  );
  assert.equal(copy.chunkPath, '2/3>1/4');
  assert.equal(copy.outerAttempt, 2);
  assert.equal(copy.providerAttempt, 1);
  assert.equal(copy.seq, op.seq);
  assert.equal(op.seq.next(), 0);
  assert.equal(copy.seq.next(), 1);
  assert.equal(op.chunkPath, '');
  assert.equal(op.outerAttempt, 0);
});
test('recorder precedence is per-call, bound, then no-op', () => {
  const a = recorder().usage;
  const b = recorder().usage;
  assert.equal(resolveRecorder({ usage: a }, b), a);
  assert.equal(resolveRecorder({}, b), b);
  assert.equal(resolveRecorder(), noopUsageRecorder);
  assert.equal(noopUsageRecorder.with({ sessionId: 's' }), noopUsageRecorder);
});
test('LLM end records once and preserves first token timing', () => {
  const { usage, records } = recorder();
  const handle = beginLlmRequest({ usage }, startOperation(), base);
  handle.firstToken();
  handle.firstToken();
  handle.end({
    outcome: 'ok',
    inputTokens: 12,
    outputTokens: 3,
    tokensSource: 'provider',
  });
  handle.end({ outcome: 'error' });
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.kind, 'llm.call');
  if (record.kind !== 'llm.call') throw new Error('Expected LLM record');
  assert.equal(record.outcome, 'ok');
  assert.equal(record.inputTokens, 12);
  assert.ok(
    record.firstTokenMs !== undefined &&
      record.firstTokenMs >= 0 &&
      record.firstTokenMs <= record.durationMs,
  );
});
test('embedding hooks share physical sequence, retain coordinates, and use bound recorder', () => {
  const { usage, records } = recorder();
  const op = withChunk(startOperation(), 1, 3);
  const handle = beginEmbeddingRequest(
    undefined,
    op,
    {
      provider: 'test',
      model: 'model',
      inputs: 3,
      inputChars: 12,
      granularity: 'request',
      retriesVisible: true,
    },
    usage,
  );
  handle.end({ outcome: 'ok', inputTokens: 5, tokensSource: 'provider' });
  handle.end({ outcome: 'error' });
  beginLlmRequest(undefined, op, base, usage).end({
    outcome: 'aborted',
    closedEarly: true,
  });
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, 'embedding.call');
  if (records[0].kind !== 'embedding.call' || records[1].kind !== 'llm.call')
    throw new Error('Unexpected kinds');
  assert.equal(records[0].chunkPath, '2/3');
  assert.equal(records[0].inputTokens, 5);
  assert.equal(records[0].physicalSeq, 0);
  assert.equal(records[1].physicalSeq, 1);
});
test('error codes contain only codes or statuses and never messages or raw errors', () => {
  const { usage, records } = recorder();
  for (const error of [
    new Error('private provider body'),
    { code: 'RATE_LIMIT', message: 'private provider body' },
    { status: 429 },
    { code: 'private provider body' },
  ]) {
    beginLlmRequest({ usage }, startOperation(), base).end({
      outcome: 'error',
      error,
    });
  }
  assert.deepEqual(
    records.map((r) => r.errorCode),
    [undefined, 'RATE_LIMIT', '429', undefined],
  );
  assert.ok(!JSON.stringify(records).includes('private provider body'));
});
test('missing and throwing recorders do not affect callers', () => {
  beginLlmRequest(undefined, startOperation(), base).end({ outcome: 'ok' });
  const usage: IUsageRecorder = {
    record() {
      throw new Error('recorder failed');
    },
    with() {
      return usage;
    },
  };
  assert.doesNotThrow(() =>
    beginLlmRequest({ usage }, startOperation(), base).end({ outcome: 'ok' }),
  );
});
