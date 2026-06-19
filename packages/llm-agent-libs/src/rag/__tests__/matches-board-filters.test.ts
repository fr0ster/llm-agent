import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KnowledgeEntryMetadata } from '@mcp-abap-adt/llm-agent';
import { matches } from '../knowledge-rag.js';

const m: KnowledgeEntryMetadata = {
  traceId: 't',
  turnId: 't',
  stepperId: 'controller',
  task: 'controller',
  artifactType: 'plan-decision',
  createdAt: 'now',
  stepId: 's1',
  decisionId: 'dA',
  slotId: 'slot1',
  kind: 'create',
};
test('matches() honours the new board-identity filters', () => {
  assert.equal(matches(m, { slotId: 'slot1' }), true);
  assert.equal(matches(m, { slotId: 'slotX' }), false);
  assert.equal(matches(m, { decisionId: 'dA' }), true);
  assert.equal(matches(m, { decisionId: 'dB' }), false);
  assert.equal(matches(m, { stepId: 's1' }), true);
  assert.equal(matches(m, { stepId: 's2' }), false);
  assert.equal(matches(m, { kind: 'create' }), true);
  assert.equal(matches(m, { kind: 'replan' }), false);
  assert.equal(
    matches(m, { artifactType: 'plan-decision', slotId: 'slot1' }),
    true,
  );
  assert.equal(
    matches(m, { artifactType: 'step-result', slotId: 'slot1' }),
    false,
  );
});
