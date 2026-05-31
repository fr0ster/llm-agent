import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStepperCoordinatorConfig } from '../config.js';

test('parses mode, mutationPolicy, knownReadOnlyTools, stepper.* with defaults', () => {
  const c = parseStepperCoordinatorConfig({
    mode: 'planned-react',
    mutationPolicy: 'trusted',
    knownReadOnlyTools: ['GetProgram', 'GetInclude'],
    stepper: {
      maxParallelSteps: 8,
      reviewer: { atDepths: [0, 1, 2] },
      maxDepth: 5,
      tokenBudget: 500000,
    },
  });
  assert.equal(c.mode, 'planned-react');
  assert.equal(c.toolSafety.mutationPolicy, 'trusted');
  assert.equal(c.toolSafety.knownReadOnlyTools.has('GetProgram'), true);
  assert.equal(c.maxParallelSteps, 8);
  assert.equal(c.reviewerAtDepths.has(0), true);
  assert.equal(c.reviewerAtDepths.has(2), true);
  assert.equal(c.reviewerAtDepths.has(3), false);
  assert.equal(c.maxDepth, 5);
  assert.equal(c.tokenBudget, 500000);
});

test('knowledgeSeed: parses entries (default artifactType=guidance), drops blanks, defaults empty', () => {
  const empty = parseStepperCoordinatorConfig({ mode: 'planned-react' });
  assert.deepEqual(empty.knowledgeSeed, []);

  const c = parseStepperCoordinatorConfig({
    mode: 'cyclic-react',
    knowledgeSeed: [
      { content: 'Read a report via GetProgram.' },
      {
        content: 'Read an include body via GetInclude.',
        artifactType: 'tool-rule',
      },
      { content: '   ' }, // blank → dropped
      { artifactType: 'x' }, // no content → dropped
    ],
  });
  assert.equal(c.knowledgeSeed.length, 2);
  assert.equal(c.knowledgeSeed[0].artifactType, 'guidance');
  assert.equal(c.knowledgeSeed[1].artifactType, 'tool-rule');
});

test('defaults: mode=planned-react, mutationPolicy=confirm, reviewer atDepths=[0,1], maxParallelSteps=4', () => {
  const c = parseStepperCoordinatorConfig({});
  assert.equal(c.mode, 'planned-react');
  assert.equal(c.toolSafety.mutationPolicy, 'confirm');
  assert.equal(c.toolSafety.knownReadOnlyTools.size, 0);
  assert.equal(c.reviewerAtDepths.has(0), true);
  assert.equal(c.reviewerAtDepths.has(1), true);
  assert.equal(c.reviewerAtDepths.has(2), false);
  assert.equal(c.maxParallelSteps, 4);
});

test("reviewer atDepths 'all' yields a predicate that accepts any depth", () => {
  const c = parseStepperCoordinatorConfig({
    stepper: { reviewer: { atDepths: 'all' } },
  });
  assert.equal(c.reviewerAtDepths.has(0), true);
  assert.equal(c.reviewerAtDepths.has(99), true);
});

test('invalid mode throws', () => {
  assert.throws(
    () => parseStepperCoordinatorConfig({ mode: 'bogus' }),
    /unknown coordinator\.mode/i,
  );
});

// ── (б2) nested flow.nodes — yaml composition tree → spec ──────────────────────

test('flow.nodes with a nested flow parses into a recursive composition spec', () => {
  const c = parseStepperCoordinatorConfig({
    mode: 'planned-react',
    flow: {
      planner: { type: 'static' },
      nodes: [
        { id: 'read', goal: 'Read the code' },
        {
          id: 'analyze',
          goal: 'Analyze',
          flow: {
            planner: { type: 'llm', granularity: 'detailed' },
            executor: { type: 'cyclic-react' },
            nodes: [{ id: 'sec', goal: 'security' }],
          },
        },
      ],
    },
  });
  assert.equal(c.flow.planner, 'static');
  assert.ok(c.flow.nodes, 'root nodes parsed');
  assert.equal(c.flow.nodes?.length, 2);
  const analyze = c.flow.nodes?.find((n) => n.id === 'analyze');
  assert.ok(analyze?.flow, 'analyze node has a nested flow');
  // nested flow keeps its own planner config…
  assert.equal(analyze?.flow?.planner, 'llm');
  assert.equal(analyze?.flow?.granularity, 'detailed');
  // …and its own nested nodes…
  assert.equal(analyze?.flow?.nodes?.[0]?.id, 'sec');
  // …while inheriting the root bounds (parallelism here defaults to 4).
  assert.equal(analyze?.flow?.maxParallelSteps, 4);
});

test('a leaf node (no nested flow) parses without a flow field', () => {
  const c = parseStepperCoordinatorConfig({
    mode: 'planned-react',
    flow: { nodes: [{ id: 'x', goal: 'do x' }] },
  });
  assert.equal(c.flow.nodes?.[0]?.flow, undefined);
});
