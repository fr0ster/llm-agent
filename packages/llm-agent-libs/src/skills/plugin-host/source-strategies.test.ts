import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMarketplaceTransport } from './http-marketplace-source.js';
import {
  type FetchedSourceConfig,
  resolveSkillSourceStrategy,
} from './source-strategies.js';

const SKILL_MD = `---\nname: s\ndescription: d\n---\n## H\nbody`;

const transport: IMarketplaceTransport = {
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

const cfg: FetchedSourceConfig = {
  source: 'v',
  enabled: ['*'],
  transport,
  chunk: { maxChars: 1000 },
};

test('one-group-per-plugin groups per plugin (≥2 plugins → ≥2 collections)', async () => {
  const src = resolveSkillSourceStrategy('one-group-per-plugin')(cfg);
  const res = await src.acquire();
  assert.ok(res.collections.length >= 2);
  assert.deepEqual(res.collections.map((c) => c.group).sort(), ['a', 'b']);
});

test('single-collection bundles all plugins into one named collection', async () => {
  const src = resolveSkillSourceStrategy('single-collection')({
    ...cfg,
    strategyConfig: { collection: 'bundle' },
  });
  const res = await src.acquire();
  assert.equal(res.collections.length, 1);
  assert.equal(res.collections[0].group, 'bundle');
});

test('single-collection defaults to "skills" when unconfigured', async () => {
  const src = resolveSkillSourceStrategy('single-collection')(cfg);
  const res = await src.acquire();
  assert.equal(res.collections.length, 1);
  assert.equal(res.collections[0].group, 'skills');
});

test('resolveSkillSourceStrategy throws on unknown, listing registered names', () => {
  assert.throws(
    () => resolveSkillSourceStrategy('nope'),
    (e: unknown) => {
      const msg = String(e);
      assert.match(msg, /nope/);
      assert.match(msg, /one-group-per-plugin/);
      assert.match(msg, /single-collection/);
      return true;
    },
  );
});
