import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeHttpMarketplaceSource } from './http-marketplace-source.js';

const SKILL_MD = `---\nname: s\ndescription: d\n---\n## H\nbody`;

test('fetches manifest + SKILL.md via injected transport, builds ingest result, zero FS', async () => {
  const src = makeHttpMarketplaceSource({
    source: 'vendor',
    enabled: ['p1'],
    transport: {
      async listPlugins() {
        return [{ plugin: 'p1', version: '1', skills: ['s'] }];
      },
      async fetchSkillMd(plugin, skill) {
        assert.equal(plugin, 'p1');
        assert.equal(skill, 's');
        return SKILL_MD;
      },
    },
    chunk: { maxChars: 1000 },
  });
  const res = await src.acquire();
  assert.deepEqual(
    res.collections.map((c) => c.group),
    ['p1'],
  );
  assert.ok(res.records.length >= 1);
});

test('enabled "*" loads every offered plugin; empty enabled is a caller error', async () => {
  const transport = {
    async listPlugins() {
      return [
        { plugin: 'a', version: '1', skills: ['s'] },
        { plugin: 'b', version: '1', skills: ['s'] },
      ];
    },
    async fetchSkillMd() {
      return SKILL_MD;
    },
  };
  const all = makeHttpMarketplaceSource({
    source: 'v',
    enabled: ['*'],
    transport,
    chunk: { maxChars: 1000 },
  });
  assert.equal((await all.acquire()).collections.length, 2);
  assert.throws(
    () =>
      makeHttpMarketplaceSource({
        source: 'v',
        enabled: [],
        transport,
        chunk: { maxChars: 1000 },
      }),
    /enabled/,
  );
});

test('only the enabled subset of offered plugins is acquired', async () => {
  const src = makeHttpMarketplaceSource({
    source: 'v',
    enabled: ['b'],
    transport: {
      async listPlugins() {
        return [
          { plugin: 'a', version: '1', skills: ['s'] },
          { plugin: 'b', version: '1', skills: ['s'] },
        ];
      },
      async fetchSkillMd() {
        return SKILL_MD;
      },
    },
    chunk: { maxChars: 1000 },
  });
  const res = await src.acquire();
  assert.deepEqual(
    res.collections.map((c) => c.group),
    ['b'],
  );
});
