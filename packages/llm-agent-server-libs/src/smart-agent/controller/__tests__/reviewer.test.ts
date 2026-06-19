import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import { LlmReviewer, parseReview } from '../reviewer.js';
import type { ISubagentClient } from '../subagent-client.js';

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

const client = (reply: string): ISubagentClient => ({
  async send() {
    return { kind: 'content', content: reply };
  },
});

describe('LlmReviewer', () => {
  it('parses a well-formed verdict into an Outcome', async () => {
    const r = new LlmReviewer(
      client(
        JSON.stringify({
          status: 'ok',
          approved: 'RESULT',
          remainder: '',
          note: 'good',
          digest: 'produced RESULT',
        }),
      ),
    );
    const res = await r.review(
      { name: 's1', instructions: 'do' },
      [{ ref: 'x', hit: true }],
      'RESULT',
      {},
    );
    assert.equal(res.kind, 'outcome');
    assert.equal(res.kind === 'outcome' && res.outcome.status, 'ok');
    assert.equal(res.kind === 'outcome' && res.outcome.approved, 'RESULT');
    assert.equal(
      res.kind === 'outcome' && res.outcome.digest,
      'produced RESULT',
    );
  });

  it('a well-formed FAILED verdict is a real step outcome (NOT a judge failure)', async () => {
    const r = new LlmReviewer(
      client(
        JSON.stringify({
          status: 'failed',
          approved: '',
          remainder: 'all',
          note: 'not done',
          digest: 'nothing fetched',
        }),
      ),
    );
    const res = await r.review(
      { name: 's1', instructions: 'do' },
      [],
      'RESULT',
      {},
    );
    assert.equal(res.kind, 'outcome');
    assert.equal(res.kind === 'outcome' && res.outcome.status, 'failed');
  });

  it('status:ok with empty approved is coerced to a FAILED outcome (replan, not abort)', async () => {
    const r = new LlmReviewer(
      client(
        JSON.stringify({
          status: 'ok',
          approved: '',
          remainder: 'all',
          note: 'nothing usable',
          digest: 'n/a',
        }),
      ),
    );
    const res = await r.review(
      { name: 's1', instructions: 'do' },
      [],
      'RESULT',
      {},
    );
    // A success/partial verdict with nothing accepted is self-contradictory → a
    // real failed outcome (planner replans), NOT a judge-failure that aborts.
    assert.equal(res.kind, 'outcome');
    assert.equal(res.kind === 'outcome' && res.outcome.status, 'failed');
    assert.equal(res.kind === 'outcome' && res.outcome.remainder, 'all');
  });

  it('an unparsable reply is a JUDGE FAILURE', async () => {
    const r = new LlmReviewer(client('not json at all'));
    const res = await r.review(
      { name: 's1', instructions: 'do' },
      [],
      'RESULT',
      {},
    );
    assert.equal(res.kind, 'judge-failure');
  });

  it('a provider error is a JUDGE FAILURE (NOT a step status:failed)', async () => {
    const errClient: ISubagentClient = {
      async send() {
        return { kind: 'error', error: 'boom' };
      },
    };
    const r = new LlmReviewer(errClient);
    const res = await r.review(
      { name: 's1', instructions: 'do' },
      [],
      'RESULT',
      {},
    );
    assert.equal(res.kind, 'judge-failure');
    assert.match(
      res.kind === 'judge-failure' ? res.reason : '',
      /boom|review/i,
    );
  });
});

describe('parseReview — partial coercion (Finding 4)', () => {
  it('partial with non-empty approved and EMPTY remainder → coerced to ok (keeps approved)', () => {
    const res = parseReview(
      JSON.stringify({
        status: 'partial',
        approved: 'ACCEPTED CONTENT',
        remainder: '',
        note: 'all done',
        digest: 'accepted content',
      }),
    );
    assert.equal(res.kind, 'outcome');
    assert.equal(res.kind === 'outcome' && res.outcome.status, 'ok');
    assert.equal(
      res.kind === 'outcome' && res.outcome.approved,
      'ACCEPTED CONTENT',
    );
    assert.equal(res.kind === 'outcome' && res.outcome.remainder, '');
    assert.equal(res.kind === 'outcome' && res.outcome.note, 'all done');
  });

  it('partial with non-empty approved and whitespace-only remainder → coerced to ok', () => {
    const res = parseReview(
      JSON.stringify({
        status: 'partial',
        approved: 'DONE',
        remainder: '   ',
        note: '',
        digest: 'done',
      }),
    );
    assert.equal(res.kind, 'outcome');
    assert.equal(res.kind === 'outcome' && res.outcome.status, 'ok');
    assert.equal(res.kind === 'outcome' && res.outcome.approved, 'DONE');
  });

  it('partial with non-empty approved AND non-empty remainder stays partial (unchanged)', () => {
    const res = parseReview(
      JSON.stringify({
        status: 'partial',
        approved: 'PART DONE',
        remainder: 'still need this',
        note: '',
        digest: 'part done',
      }),
    );
    assert.equal(res.kind, 'outcome');
    assert.equal(res.kind === 'outcome' && res.outcome.status, 'partial');
    assert.equal(res.kind === 'outcome' && res.outcome.approved, 'PART DONE');
    assert.equal(
      res.kind === 'outcome' && res.outcome.remainder,
      'still need this',
    );
  });

  it('LlmReviewer.review: partial with empty remainder → ok (via LLM path)', async () => {
    const r = new LlmReviewer(
      client(
        JSON.stringify({
          status: 'partial',
          approved: 'COMPLETE RESULT',
          remainder: '',
          note: 'everything done',
          digest: 'complete result',
        }),
      ),
    );
    const res = await r.review(
      { name: 's1', instructions: 'do it' },
      [],
      'COMPLETE RESULT',
      {},
    );
    assert.equal(res.kind, 'outcome');
    assert.equal(res.kind === 'outcome' && res.outcome.status, 'ok');
    assert.equal(
      res.kind === 'outcome' && res.outcome.approved,
      'COMPLETE RESULT',
    );
  });
});
