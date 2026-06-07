import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AdaptivePlanner, IncrementalPlanner } from '../planner.js';
import type { ISubagentClient } from '../subagent-client.js';
import type { SessionBundle, SubagentResult } from '../types.js';

const planner = (queue: SubagentResult[]): ISubagentClient => ({
  async send() {
    return queue.shift() ?? { kind: 'content', content: '' };
  },
});
const bundle = (): SessionBundle => ({
  goal: 'g',
  plannerPrivate: '',
  budgets: { stepsUsed: 0, rewindsUsed: 0 },
});

describe('IncrementalPlanner', () => {
  it('returns the planner LLM decision each call', async () => {
    const p = new IncrementalPlanner(
      planner([
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
          }),
        },
      ]),
    );
    const next = await p.next({
      bundle: bundle(),
      prompt: 'req',
      toolCatalog: '- GetX: read',
      retrying: false,
    });
    assert.equal(next?.kind, 'next');
    assert.equal(next?.kind === 'next' && next.step.name, 's1');
  });
  it('non-content planner reply → null (format failure)', async () => {
    const p = new IncrementalPlanner(planner([{ kind: 'error', error: 'x' }]));
    assert.equal(
      await p.next({
        bundle: bundle(),
        prompt: 'r',
        toolCatalog: '',
        retrying: false,
      }),
      null,
    );
  });
});

describe('AdaptivePlanner', () => {
  it('first call creates the full plan and returns step 0', async () => {
    const b = bundle();
    const p = new AdaptivePlanner(
      planner([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [
              { name: 's1', instructions: 'fetch A' },
              { name: 's2', instructions: 'fetch B' },
            ],
          }),
        },
      ]),
    );
    const next = await p.next({
      bundle: b,
      prompt: 'r',
      toolCatalog: '',
      retrying: false,
    });
    assert.equal(next?.kind, 'next');
    assert.equal(next?.kind === 'next' && next.step.name, 's1');
    assert.equal(b.plan?.length, 2);
    assert.equal(b.planCursor, 0);
  });

  it('commit advances the cursor on success; next() then returns the next step', async () => {
    const b: SessionBundle = {
      ...bundle(),
      plan: [
        { name: 's1', instructions: 'a' },
        { name: 's2', instructions: 'b' },
      ],
      planCursor: 0,
    };
    const p = new AdaptivePlanner(planner([]));
    p.commit(b, 'advanced'); // ← advance happens in commit, persisted by the handler
    assert.equal(b.planCursor, 1);
    const next = await p.next({
      bundle: b,
      prompt: 'r',
      toolCatalog: '',
      retrying: false,
      lastOutcome: 'advanced',
    });
    assert.equal(next?.kind === 'next' && next.step.name, 's2');
  });

  it('commit on failure does NOT advance the cursor', () => {
    const b: SessionBundle = {
      ...bundle(),
      plan: [{ name: 's1', instructions: 'a' }],
      planCursor: 0,
    };
    new AdaptivePlanner(planner([])).commit(b, 'failed');
    assert.equal(b.planCursor, 0);
  });

  it('finalizes (one LLM call) when the cursor passes the last step', async () => {
    // commit() already advanced the cursor past the only step.
    const b: SessionBundle = {
      ...bundle(),
      plannerPrivate: '\n[step s1] data',
      plan: [{ name: 's1', instructions: 'a' }],
      planCursor: 1,
    };
    const p = new AdaptivePlanner(
      planner([{ kind: 'content', content: 'FINAL ANSWER' }]),
    );
    const next = await p.next({
      bundle: b,
      prompt: 'r',
      toolCatalog: '',
      retrying: false,
      lastOutcome: 'advanced',
    });
    assert.equal(next?.kind, 'done');
    assert.equal(next?.kind === 'done' && next.result, 'FINAL ANSWER');
  });

  it('rejects a malformed plan step (missing instructions) → null', async () => {
    const p = new AdaptivePlanner(
      planner([
        {
          kind: 'content',
          content: JSON.stringify({ plan: [{ name: 's1' }] }),
        },
      ]),
    );
    assert.equal(
      await p.next({
        bundle: bundle(),
        prompt: 'r',
        toolCatalog: '',
        retrying: false,
      }),
      null,
    );
  });

  it("replans the remainder on lastOutcome 'failed'", async () => {
    const b: SessionBundle = {
      ...bundle(),
      plan: [
        { name: 's1', instructions: 'a' },
        { name: 's2', instructions: 'b' },
      ],
      planCursor: 0,
    };
    const p = new AdaptivePlanner(
      planner([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1b', instructions: 'retry differently' }],
          }),
        },
      ]),
    );
    const next = await p.next({
      bundle: b,
      prompt: 'r',
      toolCatalog: '',
      retrying: false,
      lastOutcome: 'failed',
    });
    assert.equal(next?.kind === 'next' && next.step.name, 's1b');
    assert.equal(b.plan?.[0].name, 's1b'); // remainder replaced from the cursor
  });

  it('replan returning an empty plan → done via finalize', async () => {
    const b: SessionBundle = {
      ...bundle(),
      plannerPrivate: '\n[step s1 failed] boom',
      plan: [{ name: 's1', instructions: 'a' }],
      planCursor: 0,
    };
    const p = new AdaptivePlanner(
      planner([
        { kind: 'content', content: JSON.stringify({ plan: [] }) }, // nothing left to do
        { kind: 'content', content: 'done despite failure' }, // finalize
      ]),
    );
    const next = await p.next({
      bundle: b,
      prompt: 'r',
      toolCatalog: '',
      retrying: false,
      lastOutcome: 'failed',
    });
    assert.equal(next?.kind, 'done');
  });

  it('unparsable create-plan reply → null (handler retries)', async () => {
    const p = new AdaptivePlanner(
      planner([{ kind: 'content', content: 'not json at all' }]),
    );
    assert.equal(
      await p.next({
        bundle: bundle(),
        prompt: 'r',
        toolCatalog: '',
        retrying: false,
      }),
      null,
    );
  });
});
