import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReview } from '../reviewer.js';

const MAX = 200;

test('parseReview returns digest on a well-formed ok verdict', () => {
  const r = parseReview(
    JSON.stringify({
      status: 'ok',
      approved: 'FULL CONTENT',
      remainder: '',
      note: 'done',
      digest: 'includes: A, B, C',
    }),
    MAX,
  );
  assert.equal(r.kind, 'outcome');
  if (r.kind !== 'outcome') return;
  assert.equal(r.outcome.status, 'ok');
  assert.equal(r.outcome.digest, 'includes: A, B, C');
});

test('parseReview judge-fails when digest is missing on a settle', () => {
  const r = parseReview(
    JSON.stringify({ status: 'ok', approved: 'X', remainder: '', note: '' }),
    MAX,
  );
  assert.equal(r.kind, 'judge-failure');
});

test('parseReview truncates an over-long digest to maxDigestChars', () => {
  const long = 'x'.repeat(500);
  const r = parseReview(
    JSON.stringify({
      status: 'ok',
      approved: 'X',
      remainder: '',
      note: '',
      digest: long,
    }),
    MAX,
  );
  assert.equal(r.kind, 'outcome');
  if (r.kind !== 'outcome') return;
  assert.equal(r.outcome.digest.length, MAX);
});

test('parseReview coerces empty-approved success to failed WITH a digest', () => {
  const r = parseReview(
    JSON.stringify({
      status: 'ok',
      approved: '',
      remainder: 'still missing Z',
      note: 'nothing usable',
      digest: 'n/a',
    }),
    MAX,
  );
  assert.equal(r.kind, 'outcome');
  if (r.kind !== 'outcome') return;
  assert.equal(r.outcome.status, 'failed');
  assert.ok(r.outcome.digest.length > 0); // synthesized from note
});

test('parseReview judge-fails on unparsable reply', () => {
  assert.equal(parseReview('not json', MAX).kind, 'judge-failure');
});
