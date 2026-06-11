import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AdaptivePlanner,
  CREATE_PLAN_SYSTEM,
  ENGLISH_INSTRUCTIONS_RULE,
  EXTERNAL_RESULT_REPLAN_SYSTEM,
  IncrementalPlanner,
  PLANNER_SYSTEM,
  REPLAN_SYSTEM,
} from '../planner.js';
import type { ISubagentClient } from '../subagent-client.js';
import {
  MAX_REQUIRE_CHARS,
  MAX_REQUIRES,
  type SessionBundle,
  type SubagentResult,
} from '../types.js';

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
      retrying: false,
    });
    assert.equal(next?.kind, 'next');
    assert.equal(next?.kind === 'next' && next.step.name, 's1');
  });
  it('appends the per-role hint to the agnostic planner prompt', async () => {
    let sys = '';
    const recording: ISubagentClient = {
      async send(messages) {
        sys =
          typeof messages[0]?.content === 'string' ? messages[0].content : '';
        return {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'ok' }),
        };
      },
    };
    await new IncrementalPlanner(recording, 'Keep the plan minimal.').next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
    });
    assert.doesNotMatch(sys, /SAP|ABAP/i);
    assert.match(sys, /Additional guidance: Keep the plan minimal\./);
    // Contract: plan by intent, never name a tool; no dangling tool-list ref.
    assert.match(sys, /do NOT (choose|name)/i);
    assert.doesNotMatch(sys, /listed below/i);
  });

  it('non-content planner reply → null (format failure)', async () => {
    const p = new IncrementalPlanner(planner([{ kind: 'error', error: 'x' }]));
    assert.equal(
      await p.next({
        bundle: bundle(),
        prompt: 'r',
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
        retrying: false,
      }),
      null,
    );
  });

  it('EMPTY create-plan {"plan":[]} → null (retry — must NOT skip to finalizer)', async () => {
    const p = new AdaptivePlanner(
      planner([{ kind: 'content', content: '{"plan":[]}' }]),
    );
    const b = bundle();
    assert.equal(
      await p.next({
        bundle: b,
        prompt: 'r',
        retrying: false,
      }),
      null,
    );
    assert.equal(b.plan, undefined); // nothing committed → clean retry
  });

  it('finalizer non-content reply → null (retry, not a fake "completed")', async () => {
    // plan present + cursor at end + no failure → stepAtCursor → finalize.
    const p = new AdaptivePlanner(planner([{ kind: 'error', error: 'boom' }]));
    const b: SessionBundle = {
      ...bundle(),
      plan: [{ name: 's1', instructions: 'do' }],
      planCursor: 1,
    };
    assert.equal(
      await p.next({
        bundle: b,
        prompt: 'r',
        retrying: false,
      }),
      null,
    );
  });

  it('a successful replan CLEARS the durable failure marker (no repeat replan)', async () => {
    const b: SessionBundle = {
      ...bundle(),
      lastOutcome: 'failed',
      plan: [{ name: 's1', instructions: 'a' }],
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
      retrying: false,
      lastOutcome: 'failed',
    });
    assert.equal(next?.kind === 'next' && next.step.name, 's1b');
    assert.equal(b.lastOutcome, undefined); // failure consumed → no re-replan on resume
  });

  it('replan tells the planner which steps ALREADY ran (so it does not repeat them)', async () => {
    let userMsg = '';
    const recording: ISubagentClient = {
      async send(messages) {
        userMsg =
          typeof messages[1]?.content === 'string' ? messages[1].content : '';
        return {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's3b', instructions: 'remaining' }],
          }),
        };
      },
    };
    const b: SessionBundle = {
      ...bundle(),
      lastOutcome: 'failed',
      plan: [
        { name: 's1', instructions: 'a' },
        { name: 's2', instructions: 'b' },
        { name: 's3', instructions: 'c' },
      ],
      planCursor: 2, // s1,s2 succeeded (cursor advanced); s3 (at cursor) failed
    };
    await new AdaptivePlanner(recording).next({
      bundle: b,
      prompt: 'r',
      retrying: false,
      lastOutcome: 'failed',
    });
    assert.match(userMsg, /ALREADY-EXECUTED/);
    assert.match(userMsg, /- s1/);
    assert.match(userMsg, /- s2/);
    assert.doesNotMatch(userMsg, /- s3\b/); // the FAILED step is not "completed"
  });

  it('agnostic prompts mention no domain (no "SAP"/"ABAP") and a hint is appended', async () => {
    let sys = '';
    const recording: ISubagentClient = {
      async send(messages) {
        sys =
          typeof messages[0]?.content === 'string' ? messages[0].content : '';
        return {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        };
      },
    };
    // Without a hint: the create-plan prompt is agnostic, no appended guidance.
    await new AdaptivePlanner(recording).next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
    });
    assert.doesNotMatch(sys, /SAP|ABAP/i);
    assert.match(sys, /live target system/);
    assert.doesNotMatch(sys, /Additional guidance:/);
    // Contract: plan by intent, never name a tool; no dangling tool-list ref.
    assert.match(sys, /do NOT (choose|name)/i);
    assert.doesNotMatch(sys, /available tools|listed below/i);

    // With a hint: it is appended as an "Additional guidance" preamble.
    await new AdaptivePlanner(recording, 'Call one tool at a time.').next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
    });
    assert.match(sys, /Additional guidance: Call one tool at a time\./);
  });

  it('empty replan then finalizer error: retry RE-FINALIZES, does not replan again', async () => {
    const b: SessionBundle = {
      ...bundle(),
      lastOutcome: 'failed',
      plannerPrivate: '\n[step s1 failed] boom',
      plan: [{ name: 's1', instructions: 'a' }],
      planCursor: 0,
    };
    const p = new AdaptivePlanner(
      planner([
        { kind: 'content', content: JSON.stringify({ plan: [] }) }, // empty replan (done)
        { kind: 'error', error: 'finalizer boom' }, // finalize fails → null
        { kind: 'content', content: 'FINAL' }, // finalize retry succeeds
      ]),
    );
    // 1st: replan→[] clears lastOutcome, finalize ERRORS → null.
    const first = await p.next({
      bundle: b,
      prompt: 'r',
      retrying: false,
      lastOutcome: 'failed',
    });
    assert.equal(first, null);
    assert.equal(b.lastOutcome, undefined); // failure already consumed by the replan
    // 2nd (retry): lastOutcome undefined → stepAtCursor → FINALIZE (not replan).
    const second = await p.next({
      bundle: b,
      prompt: 'r',
      retrying: true,
      lastOutcome: b.lastOutcome,
    });
    assert.equal(second?.kind, 'done');
    assert.equal(second?.kind === 'done' && second.result, 'FINAL');
  });
});

describe('planner prompt contract', () => {
  it('every planner/replan prompt carries the English-instructions invariant', () => {
    for (const p of [
      PLANNER_SYSTEM,
      CREATE_PLAN_SYSTEM,
      REPLAN_SYSTEM,
      EXTERNAL_RESULT_REPLAN_SYSTEM,
    ]) {
      assert.ok(
        p.includes(ENGLISH_INSTRUCTIONS_RULE),
        'prompt missing the English-instructions invariant',
      );
    }
  });
  it('the prompt cap is built from the validation constants (no drift)', () => {
    assert.ok(
      ENGLISH_INSTRUCTIONS_RULE.includes(String(MAX_REQUIRES)) &&
        ENGLISH_INSTRUCTIONS_RULE.includes(String(MAX_REQUIRE_CHARS)),
    );
  });
});

describe('AdaptivePlanner partial transition', () => {
  it('commit(partial) advances the cursor (accepted part not re-run)', () => {
    const p = new AdaptivePlanner(planner([]));
    const b: SessionBundle = {
      goal: 'g',
      plannerPrivate: '',
      budgets: { stepsUsed: 1, rewindsUsed: 0 },
      plan: [
        { name: 's1', instructions: 'i' },
        { name: 's2', instructions: 'j' },
      ],
      planCursor: 0,
    };
    p.commit(b, 'partial');
    assert.equal(b.planCursor, 1);
  });
  it('next() replans when lastOutcome is partial', async () => {
    let sawReplan = false;
    const client: ISubagentClient = {
      async send(messages) {
        if (
          typeof messages[0]?.content === 'string' &&
          /REVISED/.test(messages[0].content)
        )
          sawReplan = true;
        return { kind: 'content', content: JSON.stringify({ plan: [] }) };
      },
    };
    const p = new AdaptivePlanner(client);
    const b: SessionBundle = {
      goal: 'g',
      plannerPrivate: '\n[step s1 partial] only half',
      budgets: { stepsUsed: 1, rewindsUsed: 0 },
      plan: [{ name: 's1', instructions: 'i' }],
      planCursor: 1,
      lastOutcome: 'partial',
    };
    await p.next({
      bundle: b,
      prompt: 'p',
      lastOutcome: 'partial',
      retrying: false,
    });
    assert.ok(sawReplan, 'partial triggered a REVISED replan');
  });
});

describe('parsePlan requires validation (via AdaptivePlanner.next)', () => {
  const createPlanWith = (step: object): ISubagentClient =>
    planner([{ kind: 'content', content: JSON.stringify({ plan: [step] }) }]);
  const freshBundle = (): SessionBundle => ({
    goal: 'g',
    plannerPrivate: '',
    budgets: { stepsUsed: 0, rewindsUsed: 0 },
  });

  it('rejects a malformed requires (parse failure → null)', async () => {
    const p = new AdaptivePlanner(
      createPlanWith({ name: 's1', instructions: 'do', requires: [123] }),
    );
    const r = await p.next({
      bundle: freshBundle(),
      prompt: 'p',
      retrying: false,
    });
    assert.equal(r, null);
  });
  it('rejects an oversized requires entry', async () => {
    const p = new AdaptivePlanner(
      createPlanWith({
        name: 's1',
        instructions: 'do',
        requires: ['x'.repeat(MAX_REQUIRE_CHARS + 1)],
      }),
    );
    const r = await p.next({
      bundle: freshBundle(),
      prompt: 'p',
      retrying: false,
    });
    assert.equal(r, null);
  });
  it('carries a valid requires through trimmed', async () => {
    const p = new AdaptivePlanner(
      createPlanWith({
        name: 's1',
        instructions: 'do',
        requires: ['  table T100  '],
      }),
    );
    const r = await p.next({
      bundle: freshBundle(),
      prompt: 'p',
      retrying: false,
    });
    assert.equal(r?.kind, 'next');
    assert.deepEqual(r?.kind === 'next' && r.step.requires, ['table T100']);
  });
});
