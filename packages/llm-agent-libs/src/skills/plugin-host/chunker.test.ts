import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkSkill } from './chunker.js';

const ID = { source: 's', plugin: 'p', version: '1', skill: 'sk', group: 'g' };

test('splits by H2 and produces DISTINCT retrievalText per chunk', () => {
  const body = '## Alpha\naaa\n## Beta\nbbb'; // starts at first H2 (no preamble) → exactly two chunks
  const recs = chunkSkill(
    { ...ID, description: 'D', body },
    { maxChars: 1000 },
  );
  assert.equal(recs.length, 2);
  assert.notEqual(recs[0].retrievalText, recs[1].retrievalText);
  assert.match(recs[0].retrievalText, /D/); // description present
  assert.match(recs[0].retrievalText, /Alpha/); // heading present
  assert.equal(recs[0].id, 's:p@1/sk#0');
  assert.equal(recs[1].id, 's:p@1/sk#1');
  assert.equal(recs[0].group, 'g');
  assert.equal(recs[0].sourceId, 's');
});

test('content BEFORE the first H2 (preamble) becomes its own leading chunk', () => {
  const body = '# Title\nintro text\n## Alpha\naaa';
  const recs = chunkSkill(
    { ...ID, description: 'D', body },
    { maxChars: 1000 },
  );
  assert.equal(recs.length, 2); // [preamble "intro text", "Alpha"]
  assert.match(recs[0].content, /intro text/);
  assert.match(recs[1].retrievalText, /Alpha/);
});

test('over-long section splits further; ids stay deterministic', () => {
  const body = `## Big\n${'x'.repeat(50)}\n\n${'y'.repeat(50)}`;
  const recs = chunkSkill({ ...ID, description: 'D', body }, { maxChars: 60 });
  assert.ok(recs.length >= 2);
  const again = chunkSkill({ ...ID, description: 'D', body }, { maxChars: 60 });
  assert.deepEqual(
    recs.map((r) => r.id),
    again.map((r) => r.id),
  );
});
