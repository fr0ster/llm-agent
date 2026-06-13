import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIngestResult } from './marketplace-adapter.js';

const SKILL_MD = `---\nname: do-thing\ndescription: How to do the thing\n---\n# Do Thing\n## Step\nrun it`;

test('manifest + SKILL.md → records placed one-group-per-plugin + catalog', () => {
  const res = buildIngestResult({
    source: 'vendor',
    plugins: [
      {
        plugin: 'p1',
        version: '1',
        skills: [{ skill: 'do-thing', skillMd: SKILL_MD }],
      },
    ],
    chunk: { maxChars: 1000 },
    placement: (plugin) => ({ group: plugin, description: `plugin ${plugin}` }),
  });
  assert.deepEqual(
    res.collections.map((c) => c.group),
    ['p1'],
  );
  assert.equal(res.collections[0].description, 'plugin p1');
  assert.ok(res.records.length >= 1);
  assert.ok(res.records.every((r) => r.group === 'p1'));
  const groups = new Set(res.collections.map((c) => c.group));
  assert.ok(res.records.every((r) => groups.has(r.group)));
});

test('a strategy may bundle plugins into one group', () => {
  const res = buildIngestResult({
    source: 'vendor',
    plugins: [
      {
        plugin: 'a',
        version: '1',
        skills: [{ skill: 's', skillMd: SKILL_MD }],
      },
      {
        plugin: 'b',
        version: '1',
        skills: [{ skill: 's', skillMd: SKILL_MD }],
      },
    ],
    chunk: { maxChars: 1000 },
    placement: () => ({ group: 'bundle', description: 'bundle' }),
  });
  assert.deepEqual(
    res.collections.map((c) => c.group),
    ['bundle'],
  );
  assert.ok(res.records.every((r) => r.group === 'bundle'));
});
