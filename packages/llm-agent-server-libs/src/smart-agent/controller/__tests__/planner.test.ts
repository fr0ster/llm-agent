import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import {
  CREATE_PLAN_SYSTEM,
  ENGLISH_INSTRUCTIONS_RULE,
  EXTERNAL_RESULT_REPLAN_SYSTEM,
  makeControllerPlanner,
  parsePlan,
  REPLAN_SYSTEM,
  SMART_CREATE_PLAN_SYSTEM,
  SMART_EXTERNAL_RESULT_REPLAN_SYSTEM,
  SMART_REPLAN_SYSTEM,
  SmartExecutorPlanner,
  WEAK_CREATE_PLAN_SYSTEM,
  WEAK_EXTERNAL_RESULT_REPLAN_SYSTEM,
  WEAK_REPLAN_SYSTEM,
  WeakExecutorPlanner,
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

const fakeClient = (replies: string[]): ISubagentClient => ({
  async send() {
    const content = replies.shift() ?? '';
    return { kind: 'content', content };
  },
});

const newBundle = (opts: {
  runId: string;
  goal: string;
  plannerPrivate?: string;
}): SessionBundle => ({
  goal: opts.goal,
  plannerPrivate: opts.plannerPrivate ?? '',
  budgets: { stepsUsed: 0, rewindsUsed: 0 },
  runId: opts.runId,
});

const recordingFakeClient = (
  replies: string[],
): ISubagentClient & {
  lastUserContent: () => string;
  lastSystemContent: () => string;
} => {
  let _lastUserContent = '';
  let _lastSystemContent = '';
  return {
    async send(messages) {
      const userMsg = messages.find((m) => m.role === 'user');
      const sysMsg = messages.find((m) => m.role === 'system');
      _lastUserContent =
        typeof userMsg?.content === 'string' ? userMsg.content : '';
      _lastSystemContent =
        typeof sysMsg?.content === 'string' ? sysMsg.content : '';
      const content = replies.shift() ?? '';
      return { kind: 'content', content };
    },
    lastUserContent: () => _lastUserContent,
    lastSystemContent: () => _lastSystemContent,
  };
};

test('SmartExecutorPlanner mints create stepIds + records a create plan-decision', async () => {
  const client = fakeClient([
    JSON.stringify({
      plan: [
        { name: 'a', instructions: 'fetch a' },
        { name: 'b', instructions: 'fetch b' },
      ],
    }),
  ]);
  const p = new SmartExecutorPlanner(client);
  const b = newBundle({ runId: 'run-1', goal: 'g' });
  const next = await p.next({ bundle: b, prompt: 'g', retrying: false });
  assert.equal(next?.kind, 'next');
  assert.ok(b.plan?.every((s) => typeof s.stepId === 'string'));
  assert.equal(b.pendingPlanDecisions?.length, 1);
  const dec = b.pendingPlanDecisions?.[0];
  assert.equal(dec?.kind, 'create');
  assert.equal(dec?.steps.length, 2);
  assert.equal(dec?.steps[0].stepId, b.plan?.[0].stepId);
});

test('SmartExecutorPlanner replan mints anchored stepIds + records a replan decision', async () => {
  const client = fakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }), // create
    JSON.stringify({
      plan: [{ name: 'a2', instructions: 'fetch a differently' }],
    }), // replan
  ]);
  const p = new SmartExecutorPlanner(client);
  const b = newBundle({ runId: 'run-1', goal: 'g' });
  await p.next({ bundle: b, prompt: 'g', retrying: false }); // create; cursor 0
  const anchor = b.plan?.[0].stepId;
  b.pendingPlanDecisions = []; // controller drained the create decision
  const next = await p.next({
    bundle: b,
    prompt: 'g',
    retrying: false,
    lastOutcome: 'failed',
  });
  assert.equal(next?.kind, 'next');
  const dec = b.pendingPlanDecisions?.[0];
  assert.equal(dec?.kind, 'replan');
  assert.equal((dec as { anchor?: string })?.anchor, anchor);
  assert.equal(dec?.steps[0].supersedesStepId, anchor);
  assert.notEqual(dec?.steps[0].stepId, anchor);
});

describe('SmartExecutorPlanner', () => {
  it('first call creates the full plan and returns step 0', async () => {
    const b = bundle();
    const p = new SmartExecutorPlanner(
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
    const p = new SmartExecutorPlanner(planner([]));
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
    new SmartExecutorPlanner(planner([])).commit(b, 'failed');
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
    const p = new SmartExecutorPlanner(
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
    const p = new SmartExecutorPlanner(
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
    const p = new SmartExecutorPlanner(
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
    const p = new SmartExecutorPlanner(
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
    const p = new SmartExecutorPlanner(
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
    const p = new SmartExecutorPlanner(
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
    const p = new SmartExecutorPlanner(
      planner([{ kind: 'error', error: 'boom' }]),
    );
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
    const p = new SmartExecutorPlanner(
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
    await new SmartExecutorPlanner(recording).next({
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
    await new SmartExecutorPlanner(recording).next({
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
    await new SmartExecutorPlanner(recording, 'Call one tool at a time.').next({
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
    const p = new SmartExecutorPlanner(
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
      CREATE_PLAN_SYSTEM,
      REPLAN_SYSTEM,
      EXTERNAL_RESULT_REPLAN_SYSTEM,
      SMART_CREATE_PLAN_SYSTEM,
      SMART_REPLAN_SYSTEM,
      SMART_EXTERNAL_RESULT_REPLAN_SYSTEM,
      WEAK_CREATE_PLAN_SYSTEM,
      WEAK_REPLAN_SYSTEM,
      WEAK_EXTERNAL_RESULT_REPLAN_SYSTEM,
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
  it('the plan-creation prompt teaches the wait step', async () => {
    const client = recordingFakeClient([JSON.stringify({ plan: [] })]);
    const p = new SmartExecutorPlanner(client);
    await p.next({
      bundle: newBundle({ runId: 'run-1', goal: 'g' }),
      prompt: 'g',
      retrying: false,
    });
    const sys = client.lastSystemContent();
    assert.match(sys, /type.*wait/i);
    assert.match(sys, /waitMs/);
  });
});

describe('error-decision prompt rule (#213)', () => {
  it('CREATE and REPLAN prompts teach the {"kind":"error"} decision', () => {
    for (const p of [CREATE_PLAN_SYSTEM, REPLAN_SYSTEM]) {
      assert.match(p, /"kind"\s*:\s*"error"/);
      assert.match(p, /fixable/i);
    }
  });

  it('the rule flows into all smart/weak variants', () => {
    for (const p of [
      SMART_CREATE_PLAN_SYSTEM,
      SMART_REPLAN_SYSTEM,
      WEAK_CREATE_PLAN_SYSTEM,
      WEAK_REPLAN_SYSTEM,
    ]) {
      assert.match(p, /"kind"\s*:\s*"error"/);
    }
  });
});

describe('SmartExecutorPlanner partial transition', () => {
  it('commit(partial) advances the cursor (accepted part not re-run)', () => {
    const p = new SmartExecutorPlanner(planner([]));
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
    const p = new SmartExecutorPlanner(client);
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

test('SmartExecutorPlanner prompt carries boardText when present', async () => {
  const client = recordingFakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }),
  ]);
  const planner2 = new SmartExecutorPlanner(client);
  const b = newBundle({ runId: 'run-1', goal: 'g', plannerPrivate: '' });
  await planner2.next({
    bundle: b,
    prompt: 'g',
    retrying: false,
    boardText: '[step1aaa done] includes A,B',
  });
  assert.match(client.lastUserContent(), /includes A,B/);
});

test('SmartExecutorPlanner prompt is ADDITIVE: board + plannerPrivate deltas both survive', async () => {
  const client = recordingFakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }),
  ]);
  const planner2 = new SmartExecutorPlanner(client);
  const b = newBundle({
    runId: 'run-1',
    goal: 'g',
    plannerPrivate: '\n[clarify answer] use system PRD',
  });
  await planner2.next({
    bundle: b,
    prompt: 'g',
    retrying: false,
    boardText: '[step1aaa done] includes A,B',
  });
  const userMsg = client.lastUserContent();
  assert.match(userMsg, /includes A,B/);
  assert.match(userMsg, /use system PRD/);
});

test('SmartExecutorPlanner prompt falls back to plannerPrivate alone when boardText empty', async () => {
  const client = recordingFakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }),
  ]);
  const planner2 = new SmartExecutorPlanner(client);
  const b = newBundle({
    runId: 'run-1',
    goal: 'g',
    plannerPrivate: '\n[seq 0 a ok]',
  });
  await planner2.next({
    bundle: b,
    prompt: 'g',
    retrying: false,
    boardText: '',
  });
  assert.match(client.lastUserContent(), /\[seq 0 a ok\]/);
});

test('SmartExecutorPlanner empty replan records a tail-truncating plan-decision', async () => {
  const client = fakeClient([
    JSON.stringify({
      plan: [
        { name: 'a', instructions: 'fetch a' },
        { name: 'b', instructions: 'fetch b' },
      ],
    }), // create (2 steps)
    JSON.stringify({ plan: [] }), // empty replan
  ]);
  const planner2 = new SmartExecutorPlanner(client);
  const b = newBundle({ runId: 'run-1', goal: 'g' });
  await planner2.next({ bundle: b, prompt: 'g', retrying: false }); // create
  const anchor = b.plan?.[0].stepId; // cursor 0 → the failed step is plan[0]
  b.pendingPlanDecisions = []; // controller drained create
  await planner2.next({
    bundle: b,
    prompt: 'g',
    retrying: false,
    lastOutcome: 'failed',
  });
  const dec = b.pendingPlanDecisions?.[0];
  assert.equal(dec?.kind, 'replan');
  assert.equal(dec?.steps.length, 0); // empty replan still recorded
  assert.equal((dec as { anchor?: string })?.anchor, anchor);
});

describe('parsePlan requires validation (via SmartExecutorPlanner.next)', () => {
  const createPlanWith = (step: object): ISubagentClient =>
    planner([{ kind: 'content', content: JSON.stringify({ plan: [step] }) }]);
  const freshBundle = (): SessionBundle => ({
    goal: 'g',
    plannerPrivate: '',
    budgets: { stepsUsed: 0, rewindsUsed: 0 },
  });

  it('rejects a malformed requires (parse failure → null)', async () => {
    const p = new SmartExecutorPlanner(
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
    const p = new SmartExecutorPlanner(
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
    const p = new SmartExecutorPlanner(
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

test('makeControllerPlanner returns the kind-matched implementation', () => {
  const client = fakeClient([]);
  assert.ok(
    makeControllerPlanner('smart-executor', client) instanceof
      SmartExecutorPlanner,
  );
  assert.ok(
    makeControllerPlanner('weak-executor', client) instanceof
      WeakExecutorPlanner,
  );
});

test('WeakExecutorPlanner create-plan prompt demands ONE ATOMIC action per step (coarse forbidden)', async () => {
  const client = recordingFakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }),
  ]);
  const p = new WeakExecutorPlanner(client);
  const b = newBundle({ runId: 'run-1', goal: 'g', plannerPrivate: '' });
  await p.next({ bundle: b, prompt: 'g', retrying: false });
  const sys = client.lastSystemContent();
  assert.match(sys, /EXACTLY ONE ATOMIC action/); // weak granularity clause present
  assert.doesNotMatch(sys, /a step MAY be COARSE/); // NOT the smart clause
});

test('SmartExecutorPlanner create-plan prompt PERMITS coarse, self-expanding steps', async () => {
  const client = recordingFakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }),
  ]);
  const p = new SmartExecutorPlanner(client);
  const b = newBundle({ runId: 'run-1', goal: 'g', plannerPrivate: '' });
  await p.next({ bundle: b, prompt: 'g', retrying: false });
  const sys = client.lastSystemContent();
  assert.match(sys, /a step MAY be COARSE/); // smart granularity clause present
  assert.doesNotMatch(sys, /EXACTLY ONE ATOMIC action/); // NOT the weak clause
});

test('parsePlan preserves waitMs on a wait step', () => {
  const plan = parsePlan(
    JSON.stringify({
      plan: [
        {
          name: 'settle',
          instructions: 'let activation settle',
          type: 'wait',
          waitMs: 30000,
        },
      ],
    }),
  );
  assert.equal(plan?.[0].waitMs, 30000);
  assert.equal(plan?.[0].type, 'wait');
});

for (const bad of [
  undefined,
  '30000',
  Number.NaN,
  Number.POSITIVE_INFINITY,
  -1,
  0,
  1.5,
]) {
  test(`parsePlan rejects a wait step with waitMs=${String(bad)}`, () => {
    const plan = parsePlan(
      JSON.stringify({
        plan: [
          {
            name: 'settle',
            instructions: 'x',
            type: 'wait',
            ...(bad === undefined ? {} : { waitMs: bad }),
          },
        ],
      }),
    );
    assert.equal(plan, null);
  });
}

test('waitMs on a NON-wait step is ignored, step still parses', () => {
  const plan = parsePlan(
    JSON.stringify({
      plan: [{ name: 'read', instructions: 'read X', waitMs: 5 }],
    }),
  );
  assert.equal(plan?.length, 1);
  assert.equal(plan?.[0].waitMs, undefined);
});

describe('parsePlan — error decision (#213)', () => {
  it('parses the canonical {"kind":"error","error":…} to a PlanError', () => {
    const r = parsePlan(
      JSON.stringify({ kind: 'error', error: 'ZD is taken' }),
    );
    assert.deepEqual(r, { kind: 'error', error: 'ZD is taken' });
  });

  it('rejects a bare {"error":…} without kind → null (format failure → retry)', () => {
    const r = parsePlan(JSON.stringify({ error: 'ZD is taken' }));
    assert.equal(r, null);
  });

  it('still parses a normal {"plan":[…]} to Step[] unchanged', () => {
    const r = parsePlan(
      JSON.stringify({ plan: [{ name: 's1', instructions: 'do' }] }),
    );
    assert.ok(Array.isArray(r));
    assert.equal((r as unknown[]).length, 1);
    assert.deepEqual(r, [{ name: 's1', instructions: 'do' }]);
  });

  it('rejects {"kind":"error"} with a non-string error → null', () => {
    const r = parsePlan(JSON.stringify({ kind: 'error', error: 42 }));
    assert.equal(r, null);
  });
});

describe('SmartExecutorPlanner.next — error propagation (#213)', () => {
  it('create-plan error decision → NextStep {kind:error}', async () => {
    const p = new SmartExecutorPlanner(
      planner([
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'error',
            error: 'pinned name ZD_X is taken',
          }),
        },
      ]),
    );
    const b = bundle();
    const r = await p.next({
      bundle: b,
      prompt: 'create ZD_X',
      retrying: false,
    });
    assert.deepEqual(r, { kind: 'error', error: 'pinned name ZD_X is taken' });
  });

  it('replan error decision → NextStep {kind:error}', async () => {
    const p = new SmartExecutorPlanner(
      planner([
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'error',
            error: 'lock will not clear',
          }),
        },
      ]),
    );
    const b = bundle();
    b.plan = [{ name: 's1', instructions: 'do' }];
    b.planCursor = 0;
    const r = await p.next({
      bundle: b,
      prompt: 'x',
      retrying: false,
      lastOutcome: 'failed',
    });
    assert.deepEqual(r, { kind: 'error', error: 'lock will not clear' });
  });
});
