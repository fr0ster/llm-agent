import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BoardInputs, reconstructBoard } from '../board.js';
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
