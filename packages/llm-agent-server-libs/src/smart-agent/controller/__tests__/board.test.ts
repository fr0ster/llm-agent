import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type BoardBudget,
  type BoardEntry,
  type BoardInputs,
  reconstructBoard,
  reconstructPlanStructure,
  renderBoard,
  validateBoardBudget,
} from '../board.js';
import { renderLiveBoard } from '../controller-coordinator-handler.js';
import type { InFlightStep, PendingMarker } from '../types.js';

const meta = (m: Record<string, unknown>) => ({
  content: m.content ?? '',
  metadata: {
    traceId: 't',
    turnId: 't',
    stepperId: 'controller',
    task: 'controller',
    createdAt: 'now',
    ...m,
  },
});

test('failed(attempt0) → executing(attempt1 claim, no result) → done(attempt1 result)', () => {
  const structure = [
    {
      runId: 'r',
      kind: 'create' as const,
      steps: [{ stepId: 's1', name: 'Fetch', instructions: 'read' }],
    },
  ];
  const stepResults = [
    meta({
      artifactType: 'step-result',
      runId: 'r',
      stepId: 's1',
      seq: 0,
      attempt: 0,
      status: 'failed',
      digest: 'd0',
      writeOrdinal: 1,
    }),
  ];
  const claims = [
    {
      runId: 'r',
      slotId: 'slot1',
      stepId: 's1',
      seq: 0,
      attempt: 1,
      decisionId: 'decA',
      writeOrdinal: 2,
    },
  ];
  const board1 = reconstructBoard({
    structure,
    stepResults,
    claims,
    inFlight: undefined,
  } as BoardInputs);
  assert.equal(board1.get('s1')!.state, 'executing');

  const stepResults2 = [
    ...stepResults,
    meta({
      artifactType: 'step-result',
      runId: 'r',
      stepId: 's1',
      seq: 0,
      attempt: 1,
      status: 'ok',
      digest: 'd1',
      writeOrdinal: 3,
    }),
  ];
  const board2 = reconstructBoard({
    structure,
    stepResults: stepResults2,
    claims,
    inFlight: undefined,
  } as BoardInputs);
  assert.equal(board2.get('s1')!.state, 'done');
  assert.equal(board2.get('s1')!.digest, 'd1');
});

test('digest is taken from the max-writeOrdinal entry of the resolved status (order-independent)', () => {
  const structure = [
    {
      runId: 'r',
      kind: 'create' as const,
      steps: [{ stepId: 's1', name: 'X', instructions: 'y' }],
    },
  ];
  // two 'ok' results for attempt 0, inserted HIGHER-ordinal FIRST:
  const stepResults = [
    meta({
      artifactType: 'step-result',
      runId: 'r',
      stepId: 's1',
      seq: 0,
      attempt: 0,
      status: 'ok',
      digest: 'latest',
      writeOrdinal: 5,
    }),
    meta({
      artifactType: 'step-result',
      runId: 'r',
      stepId: 's1',
      seq: 0,
      attempt: 0,
      status: 'ok',
      digest: 'older',
      writeOrdinal: 2,
    }),
  ];
  const b = reconstructBoard({
    structure,
    stepResults,
    claims: [],
    inFlight: undefined,
  } as BoardInputs);
  assert.equal(b.get('s1')!.state, 'done');
  assert.equal(b.get('s1')!.digest, 'latest'); // max writeOrdinal, not insertion order
});

test('precedence among settled attempts: a late failed does NOT overwrite a committed ok', () => {
  const structure = [
    {
      runId: 'r',
      kind: 'create' as const,
      steps: [{ stepId: 's1', name: 'X', instructions: 'y' }],
    },
  ];
  const stepResults = [
    meta({
      artifactType: 'step-result',
      runId: 'r',
      stepId: 's1',
      seq: 0,
      attempt: 0,
      status: 'ok',
      digest: 'good',
      writeOrdinal: 1,
    }),
    meta({
      artifactType: 'step-result',
      runId: 'r',
      stepId: 's1',
      seq: 0,
      attempt: 0,
      status: 'failed',
      digest: 'bad',
      writeOrdinal: 2,
    }),
  ];
  const b = reconstructBoard({
    structure,
    stepResults,
    claims: [],
    inFlight: undefined,
  } as BoardInputs);
  assert.equal(b.get('s1')!.state, 'done');
});

test('a planned step with no result/claim is "planned"', () => {
  const structure = [
    {
      runId: 'r',
      kind: 'create' as const,
      steps: [{ stepId: 's1', name: 'X', instructions: 'y' }],
    },
  ];
  const b = reconstructBoard({
    structure,
    stepResults: [],
    claims: [],
    inFlight: undefined,
  } as BoardInputs);
  assert.equal(b.get('s1')!.state, 'planned');
});

test('in-flight step + external-tool pending → awaiting-external (run-level pending threaded in)', () => {
  const structure = [
    {
      runId: 'r',
      kind: 'create' as const,
      steps: [{ stepId: 's1', name: 'X', instructions: 'y' }],
    },
  ];
  const inFlight = {
    seq: 0,
    step: { stepId: 's1', name: 'X', instructions: 'y' },
    attempt: 0,
    resumeCount: 0,
    phase: 'executing',
    transcript: [],
    toolCallCount: 0,
  } satisfies InFlightStep;
  const pending = {
    kind: 'external-tool',
    extId: 'e',
    toolName: 't',
    args: {},
    position: 'p',
  } satisfies PendingMarker;
  const b = reconstructBoard({
    structure,
    stepResults: [],
    claims: [],
    inFlight,
    pending,
  } satisfies BoardInputs);
  assert.equal(b.get('s1')!.state, 'awaiting-external');
  const b2 = reconstructBoard({
    structure,
    stepResults: [],
    claims: [],
    inFlight,
  } satisfies BoardInputs);
  assert.equal(b2.get('s1')!.state, 'executing');
});

test('a later plan-decision replaces an earlier step entry (structure append/replace)', () => {
  const structure = [
    {
      runId: 'r',
      kind: 'create' as const,
      steps: [{ stepId: 's1', name: 'Old', instructions: 'old' }],
    },
    {
      runId: 'r',
      kind: 'replan' as const,
      steps: [{ stepId: 's1', name: 'New', instructions: 'new' }],
    },
  ];
  const b = reconstructBoard({
    structure,
    stepResults: [],
    claims: [],
    inFlight: undefined,
  } as BoardInputs);
  assert.equal(b.get('s1')!.name, 'New');
});

const BUDGET: BoardBudget = {
  maxDigestChars: 80,
  maxIntentChars: 40,
  maxActiveSteps: 8,
  maxBoardChars: 4000,
  keepRecentDigests: 3,
};

function entry(p: Partial<BoardEntry> & { stepId: string }): BoardEntry {
  return {
    name: p.name ?? 'step',
    instructions: p.instructions ?? 'do the thing',
    state: p.state ?? 'planned',
    ...p,
  };
}

test('renderBoard renders actionable steps individually with stepId + state', () => {
  const board = new Map<string, BoardEntry>([
    [
      's1',
      entry({
        stepId: 's1aaaaaa',
        state: 'planned',
        instructions: 'fetch the list',
      }),
    ],
    [
      's2',
      entry({
        stepId: 's2bbbbbb',
        state: 'executing',
        seq: 1,
        instructions: 'read row 1',
      }),
    ],
  ]);
  const text = renderBoard(board, BUDGET);
  assert.match(text, /planned/);
  assert.match(text, /executing/);
  assert.match(text, /fetch the list/);
  assert.match(text, /s1aaaaaa/);
});

test('renderBoard keeps the most recent K terminal digests in full, summarizes older', () => {
  const board = new Map<string, BoardEntry>();
  for (let i = 0; i < 6; i++) {
    board.set(
      `d${i}`,
      entry({
        stepId: `step${i}`,
        name: `n${i}`,
        state: 'done',
        seq: i,
        digest: `DIGEST_${i}`,
      }),
    );
  }
  const text = renderBoard(board, BUDGET); // keepRecentDigests = 3
  assert.match(text, /DIGEST_5/);
  assert.match(text, /DIGEST_3/);
  assert.doesNotMatch(text, /DIGEST_0/);
  assert.match(text, /seq 0 n0 done/);
});

test('renderBoard truncates a non-discovery digest to maxDigestChars', () => {
  const board = new Map<string, BoardEntry>([
    [
      'd',
      entry({ stepId: 's', state: 'done', seq: 0, digest: 'y'.repeat(500) }),
    ],
  ]);
  const text = renderBoard(board, BUDGET);
  assert.ok(!text.includes('y'.repeat(81)));
});

test('renderBoard truncates actionable intent to maxIntentChars', () => {
  const board = new Map<string, BoardEntry>([
    [
      's',
      entry({ stepId: 's', state: 'planned', instructions: 'z'.repeat(200) }),
    ],
  ]);
  const text = renderBoard(board, BUDGET);
  assert.ok(!text.includes('z'.repeat(41)));
});

test('renderBoard is empty for an empty board', () => {
  assert.equal(renderBoard(new Map(), BUDGET), '');
});

test('renderBoard never returns over-cap text — throws when it cannot compact enough', () => {
  const tight: BoardBudget = {
    ...BUDGET,
    maxBoardChars: 60,
    maxActiveSteps: 100,
  };
  const board = new Map<string, BoardEntry>();
  for (let i = 0; i < 10; i++) {
    board.set(
      `s${i}`,
      entry({
        stepId: `actv${i}`,
        state: 'planned',
        instructions: 'x'.repeat(40),
      }),
    );
  }
  assert.throws(
    () => renderBoard(board, tight),
    /BoardOverBudget|maxBoardChars/,
  );
});

test('renderBoard output never exceeds maxBoardChars when it does return', () => {
  const board = new Map<string, BoardEntry>();
  for (let i = 0; i < 40; i++) {
    board.set(
      `d${i}`,
      entry({
        stepId: `step${i}`,
        name: `n${i}`,
        state: 'done',
        seq: i,
        digest: `D${i}`.repeat(10),
      }),
    );
  }
  const text = renderBoard(board, BUDGET);
  assert.ok(text.length <= BUDGET.maxBoardChars);
});

test('reconstructBoard populates entry.seq from winner metadata for a settled step', () => {
  const structure = [
    {
      runId: 'r',
      kind: 'create' as const,
      steps: [{ stepId: 's1', name: 'Fetch', instructions: 'read' }],
    },
  ];
  const stepResults = [
    meta({
      artifactType: 'step-result',
      runId: 'r',
      stepId: 's1',
      seq: 3,
      attempt: 0,
      status: 'ok',
      digest: 'd',
      writeOrdinal: 1,
    }),
  ];
  const b = reconstructBoard({
    structure,
    stepResults,
    claims: [],
    inFlight: undefined,
  } as BoardInputs);
  assert.equal(b.get('s1')?.seq, 3, 'seq populated from winner metadata');
});

test('renderBoard recency-by-seq: keepRecentDigests=1 keeps the highest-seq digest', () => {
  const budget: BoardBudget = { ...BUDGET, keepRecentDigests: 1 };
  const board = new Map<string, BoardEntry>([
    [
      'a',
      entry({
        stepId: 'stepA',
        name: 'A',
        state: 'done',
        seq: 1,
        digest: 'D1',
      }),
    ],
    [
      'b',
      entry({
        stepId: 'stepB',
        name: 'B',
        state: 'done',
        seq: 5,
        digest: 'D5',
      }),
    ],
  ]);
  const text = renderBoard(board, budget);
  // seq=5 (D5) is the most recent → kept in full
  assert.match(text, /D5/, 'highest-seq digest kept in full');
  // seq=1 (D1) is older → compacted to a summary line (no digest content)
  assert.doesNotMatch(text, /D1/, 'older digest content compacted away');
  // summary line for seq=1 still appears
  assert.match(text, /seq 1/, 'summary line for older seq present');
});

test('validateBoardBudget passes a well-sized budget', () => {
  assert.doesNotThrow(() => validateBoardBudget(BUDGET));
});

test('validateBoardBudget fails loud when the worst case cannot fit', () => {
  assert.throws(
    () => validateBoardBudget({ ...BUDGET, maxBoardChars: 50 }),
    /maxBoardChars/,
  );
});

// ─── Phase 2 P1: canonical plan-decision arbitration ─────────────────────────

test('crash-dup create — latest create (higher writeOrdinal) wins, no orphan entries', () => {
  // Two `create` decisions for the same run (crash-retry scenario): the first
  // (writeOrdinal 1) had steps s0,s1,s2; the second (writeOrdinal 2) replaced
  // it with only s0. No step-results — the orphan s1/s2 must NOT appear.
  const structure = [
    {
      runId: 'r',
      kind: 'create' as const,
      steps: [
        { stepId: 's0', name: 'A', instructions: 'do A' },
        { stepId: 's1', name: 'B', instructions: 'do B' },
        { stepId: 's2', name: 'C', instructions: 'do C' },
      ],
      writeOrdinal: 1,
    },
    {
      runId: 'r',
      kind: 'create' as const,
      steps: [{ stepId: 's0', name: 'A', instructions: 'do A' }],
      writeOrdinal: 2,
    },
  ];
  const b = reconstructBoard({
    structure,
    stepResults: [],
    claims: [],
    inFlight: undefined,
  } as BoardInputs);
  assert.ok(b.has('s0'), 's0 must be on the board');
  assert.ok(
    !b.has('s1'),
    's1 is an orphan from the stale create — must not appear',
  );
  assert.ok(
    !b.has('s2'),
    's2 is an orphan from the stale create — must not appear',
  );
});

test('replan tail-replacement — unexecuted dropped step excluded, executed superseded step resurrected', () => {
  // create(s0,s1,s2)@wo1 + replan([s1prime supersedes s1])@wo2
  // s0 ran and succeeded; s1 ran and failed; replan introduced s1prime.
  // Expected board: s0(done), s1(failed — executed history), s1prime(planned), NO s2.
  const structure = [
    {
      runId: 'r',
      kind: 'create' as const,
      steps: [
        { stepId: 's0', name: 'A', instructions: 'do A' },
        { stepId: 's1', name: 'B', instructions: 'do B' },
        { stepId: 's2', name: 'C', instructions: 'do C' },
      ],
      writeOrdinal: 1,
    },
    {
      runId: 'r',
      kind: 'replan' as const,
      steps: [
        {
          stepId: 's1prime',
          name: 'B-redo',
          instructions: 'redo B',
          supersedesStepId: 's1',
        },
      ],
      writeOrdinal: 2,
    },
  ];
  const stepResults = [
    meta({
      artifactType: 'step-result',
      runId: 'r',
      stepId: 's0',
      seq: 0,
      attempt: 0,
      status: 'ok',
      digest: 'd0',
      writeOrdinal: 10,
    }),
    meta({
      artifactType: 'step-result',
      runId: 'r',
      stepId: 's1',
      seq: 1,
      attempt: 0,
      status: 'failed',
      digest: 'err1',
      writeOrdinal: 11,
    }),
  ];
  const b = reconstructBoard({
    structure,
    stepResults,
    claims: [],
    inFlight: undefined,
  } as BoardInputs);

  assert.ok(
    b.has('s0'),
    's0 must be on the board (executed + in canonical plan)',
  );
  assert.equal(b.get('s0')!.state, 'done', 's0 state must be done');

  assert.ok(b.has('s1'), 's1 must be resurrected (executed history, §F)');
  assert.equal(b.get('s1')!.state, 'failed', 's1 state must be failed');

  assert.ok(b.has('s1prime'), 's1prime must be on the board (canonical plan)');
  assert.equal(
    b.get('s1prime')!.state,
    'planned',
    's1prime state must be planned',
  );

  assert.ok(
    !b.has('s2'),
    's2 is unexecuted + dropped by replan — must not appear (phantom)',
  );
});

test('reconstructPlanStructure unit — create then replan produces correct canonical stepIds', () => {
  const decisions = [
    {
      runId: 'r',
      kind: 'create' as const,
      steps: [
        { stepId: 's0', name: 'A', instructions: 'do A' },
        { stepId: 's1', name: 'B', instructions: 'do B' },
        { stepId: 's2', name: 'C', instructions: 'do C' },
      ],
      writeOrdinal: 1,
    },
    {
      runId: 'r',
      kind: 'replan' as const,
      steps: [
        {
          stepId: 's1prime',
          name: 'B-redo',
          instructions: 'redo B',
          supersedesStepId: 's1',
        },
      ],
      writeOrdinal: 2,
    },
  ];
  const plan = reconstructPlanStructure(decisions);
  assert.deepEqual(
    plan.map((s) => s.stepId),
    ['s0', 's1prime'],
    'canonical plan must be [s0, s1prime] — s2 dropped by replan tail-replacement',
  );
});

// ─── Phase 2 P1: empty-replan tail-truncation fix ────────────────────────────

test('reconstructPlanStructure: empty replan truncates the tail from the anchor', () => {
  // create(s0,s1,s2)@1 + empty replan anchored at s1 @2
  // s1 failed → the anchor is s1 → everything from s1 onward is dropped.
  // canonical plan must be [s0] only.
  const decisions = [
    {
      runId: 'r',
      kind: 'create' as const,
      writeOrdinal: 1,
      steps: [
        { stepId: 's0', name: 'a', instructions: 'a' },
        { stepId: 's1', name: 'b', instructions: 'b' },
        { stepId: 's2', name: 'c', instructions: 'c' },
      ],
    },
    {
      runId: 'r',
      kind: 'replan' as const,
      writeOrdinal: 2,
      anchorStepId: 's1',
      steps: [],
    },
  ];
  const plan = reconstructPlanStructure(
    decisions as Parameters<typeof reconstructPlanStructure>[0],
  );
  assert.deepEqual(
    plan.map((s) => s.stepId),
    ['s0'],
  );
});

test('reconstructBoard: empty replan drops unexecuted tail; executed anchor stays failed', () => {
  // create(s0,s1,s2)@1 + empty replan anchored at s1 @2
  // stepResults: s0 ok, s1 failed
  // Expected board: s0(done), s1(failed, resurrected), NO s2
  const structure = [
    {
      runId: 'r',
      kind: 'create' as const,
      writeOrdinal: 1,
      steps: [
        { stepId: 's0', name: 'a', instructions: 'a' },
        { stepId: 's1', name: 'b', instructions: 'b' },
        { stepId: 's2', name: 'c', instructions: 'c' },
      ],
    },
    {
      runId: 'r',
      kind: 'replan' as const,
      writeOrdinal: 2,
      anchorStepId: 's1',
      steps: [],
    },
  ];
  const stepResults = [
    meta({
      artifactType: 'step-result',
      runId: 'r',
      stepId: 's0',
      seq: 0,
      attempt: 0,
      status: 'ok',
      digest: 'd0',
      writeOrdinal: 10,
    }),
    meta({
      artifactType: 'step-result',
      runId: 'r',
      stepId: 's1',
      seq: 1,
      attempt: 0,
      status: 'failed',
      digest: 'err1',
      writeOrdinal: 11,
    }),
  ];
  const b = reconstructBoard({
    structure: structure as BoardInputs['structure'],
    stepResults,
    claims: [],
    inFlight: undefined,
  } as BoardInputs);

  assert.ok(b.has('s0'), 's0 must be on the board');
  assert.equal(b.get('s0')!.state, 'done', 's0 must be done');

  assert.ok(b.has('s1'), 's1 must be resurrected (executed history)');
  assert.equal(b.get('s1')!.state, 'failed', 's1 must be failed');

  assert.ok(
    !b.has('s2'),
    's2 is unexecuted + dropped by empty replan — must not appear',
  );
});

// ─── renderLiveBoard characterization (gap test — R2) ────────────────────────

const GAP_BUDGET: BoardBudget = {
  maxDigestChars: 80,
  maxIntentChars: 40,
  maxActiveSteps: 8,
  maxBoardChars: 4000,
  keepRecentDigests: 3,
};

test('renderLiveBoard: absent runId returns empty string', async () => {
  const bundle = {
    goal: '',
    plannerPrivate: '',
    budgets: { stepsUsed: 0, rewindsUsed: 0 },
    // runId intentionally absent
  };
  const fakeRag = {
    list: async () => [],
    search: async () => [],
    put: async () => undefined,
    embed: async () => [],
  };
  const result = await renderLiveBoard(
    fakeRag as any,
    bundle as any,
    GAP_BUDGET,
  );
  assert.equal(result, '');
});

test('renderLiveBoard: delegates to reconstructBoard + renderBoard', async () => {
  const runId = 'run1';
  const planDecisionEntry = {
    content: JSON.stringify({
      steps: [{ stepId: 's1', name: 'Do it', instructions: 'do the thing' }],
    }),
    metadata: {
      traceId: 't',
      turnId: 't',
      stepperId: 'controller',
      task: 'controller',
      artifactType: 'plan-decision',
      runId,
      kind: 'create',
      writeOrdinal: 1,
      createdAt: 'now',
    },
  };
  const stepResultEntry = meta({
    artifactType: 'step-result',
    runId,
    stepId: 's1',
    seq: 0,
    attempt: 0,
    status: 'ok',
    digest: 'done well',
    writeOrdinal: 2,
  });
  const claimEntry = {
    content: '',
    metadata: {
      traceId: 't',
      turnId: 't',
      stepperId: 'controller',
      task: 'controller',
      artifactType: 'step-start',
      runId,
      slotId: 'slot1',
      stepId: 's1',
      seq: 0,
      attempt: 0,
      decisionId: 'dec1',
      writeOrdinal: 1,
      createdAt: 'now',
    },
  };
  const fakeRag = {
    list: async (filter: { runId?: string; artifactType?: string }) => {
      if (filter.artifactType === 'plan-decision') return [planDecisionEntry];
      if (filter.artifactType === 'step-start') return [claimEntry];
      if (filter.artifactType === 'step-result') return [stepResultEntry];
      return [];
    },
    search: async () => [],
    put: async () => undefined,
    embed: async () => [],
  };
  const bundle = {
    goal: '',
    plannerPrivate: '',
    budgets: { stepsUsed: 0, rewindsUsed: 0 },
    runId,
  };
  const result = await renderLiveBoard(
    fakeRag as any,
    bundle as any,
    GAP_BUDGET,
  );
  // The structure readPlanDecisions produces:
  const structure = [
    {
      runId,
      kind: 'create' as const,
      steps: [{ stepId: 's1', name: 'Do it', instructions: 'do the thing' }],
      writeOrdinal: 1,
    },
  ];
  const claims = [
    {
      runId,
      slotId: 'slot1',
      stepId: 's1',
      seq: 0,
      attempt: 0,
      decisionId: 'dec1',
      writeOrdinal: 1,
    },
  ];
  const stepResults = [stepResultEntry];
  const expected = renderBoard(
    reconstructBoard({
      structure,
      stepResults,
      claims,
      inFlight: undefined,
    } as BoardInputs),
    GAP_BUDGET,
  );
  assert.equal(result, expected);
});
