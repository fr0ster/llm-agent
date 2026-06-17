import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  KnowledgeEntryMetadata,
  KnowledgeFilter,
} from '../knowledge-rag.js';

test('KnowledgeEntryMetadata carries the controller board-identity fields', () => {
  const m: KnowledgeEntryMetadata = {
    traceId: 't',
    turnId: 't',
    stepperId: 'controller',
    task: 'controller',
    artifactType: 'plan-decision',
    createdAt: 'now',
    stepId: 's1',
    decisionId: 'd1',
    slotId: 'run|create',
    kind: 'create',
    digest: 'the include list',
    supersedesStepId: 's0',
  };
  assert.equal(m.stepId, 's1');
  assert.equal(m.kind, 'create');
  const f: KnowledgeFilter = {
    runId: 'r',
    artifactType: 'plan-decision',
    slotId: 'run|create',
  };
  assert.equal(f.slotId, 'run|create');
});
