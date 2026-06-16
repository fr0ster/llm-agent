import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillsRagSource } from './skills-rag-source.js';

test('query uses IQueryEmbedding.text (NOT toVector) and maps SkillHit→RagResult', async () => {
  let usedToVector = false;
  const handle = {
    async query(text: string) {
      assert.equal(text, 'goal-text');
      return [
        {
          record: {
            id: 'i',
            name: 'n',
            content: 'BODY',
            provenance: 'pv',
            group: 'g',
          },
          score: 0.91,
        },
      ];
    },
    async activeManifest() {
      return {
        revision: 'g0',
        manifest: {
          embeddingSpaceId: 'sp',
          dimension: 3,
          retrievalSchemaVersion: 1,
        },
      };
    },
  };
  const src = skillsRagSource(handle as never, {
    group: 'g',
    k: 4,
    threshold: 0.3,
  });
  const embedding = {
    text: 'goal-text',
    async toVector() {
      usedToVector = true;
      return [0, 0, 0];
    },
  };
  const res = await src.query(embedding as never, 4);
  assert.equal(res.ok, true);
  const value = (
    res as {
      value: Array<{ text: string; score: number; metadata: { id: string } }>;
    }
  ).value;
  assert.equal(value[0].text, 'BODY');
  assert.equal(value[0].score, 0.91);
  assert.equal(value[0].metadata.id, 'i');
  assert.equal(usedToVector, false); // re-embeds via the skills handle, not the assembler vector
});

test('healthCheck ok when activeManifest resolves; writer undefined; getById ok(null)', async () => {
  const handle = {
    async query() {
      return [];
    },
    async activeManifest() {
      return { revision: 'g', manifest: {} as never };
    },
  };
  const src = skillsRagSource(handle as never, { group: 'g', k: 4 });
  assert.equal((await src.healthCheck()).ok, true);
  assert.equal(src.writer?.(), undefined);
  const byId = await src.getById('x');
  assert.equal(byId.ok, true);
  assert.equal((byId as { value: unknown }).value, null);
});
