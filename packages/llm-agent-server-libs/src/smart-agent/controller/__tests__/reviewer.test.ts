import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmReviewer } from '../reviewer.js';
import type { ISubagentClient } from '../subagent-client.js';

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
  });

  it('a well-formed FAILED verdict is a real step outcome (NOT a judge failure)', async () => {
    const r = new LlmReviewer(
      client(
        JSON.stringify({
          status: 'failed',
          approved: '',
          remainder: 'all',
          note: 'not done',
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

  it('status:ok with empty approved is a JUDGE FAILURE (re-ask, not a step failure)', async () => {
    const r = new LlmReviewer(
      client(
        JSON.stringify({ status: 'ok', approved: '', remainder: '', note: '' }),
      ),
    );
    const res = await r.review(
      { name: 's1', instructions: 'do' },
      [],
      'RESULT',
      {},
    );
    assert.equal(res.kind, 'judge-failure');
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
