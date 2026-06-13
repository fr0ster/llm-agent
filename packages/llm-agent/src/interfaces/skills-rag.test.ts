import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CatalogSnapshot,
  SkillIngestResult,
  SkillLoadResult,
  SkillRecord,
} from './skills-rag.js';
import { CatalogCasError, SkillsIncompatibleError } from './skills-rag.js';

test('skills-rag contract shapes compile and are constructible', () => {
  const rec: SkillRecord = {
    id: 's:p@1/skill#0',
    sourceId: 's',
    group: 'g',
    name: 'p/skill',
    retrievalText: 'desc\n## h\nbody',
    content: 'body',
    provenance: 'p@1/skill#h',
  };
  const ingest: SkillIngestResult = {
    collections: [{ group: 'g', description: 'd', collection: 'g' }],
    records: [rec],
  };
  const snap: CatalogSnapshot = { catalogRevision: 'r0', entries: [] };
  const result: SkillLoadResult = {
    committed: ['g'],
    omitted: [],
    tombstoned: [],
    ok: true,
  };
  assert.equal(ingest.records[0].group, 'g');
  assert.equal(snap.entries.length, 0);
  assert.equal(result.ok, true);
  assert.ok(new CatalogCasError('x') instanceof Error);
  assert.ok(new SkillsIncompatibleError('x') instanceof Error);
});
