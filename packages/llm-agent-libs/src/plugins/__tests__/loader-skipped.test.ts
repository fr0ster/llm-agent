/**
 * Spec §17.43 D96: a file in a plugin directory is DISCOVERED, not required. A
 * discovered file that fails to load is reported in `LoadedPlugins.skipped`,
 * never in `errors` — `errors` holds only the plugins a loader was told to load.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FileSystemPluginLoader } from '../loader.js';

describe('FileSystemPluginLoader — discovered files (D96)', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugins-skipped-'));
    await writeFile(
      join(dir, 'a-good.mjs'),
      'export const reranker = { rerank: async (_q, r) => ({ ok: true, value: r }) };\n',
    );
    await writeFile(
      join(dir, 'b-broken.mjs'),
      "throw new Error('broken plugin at import');\n",
    );
    await writeFile(
      join(dir, 'c-defect.mjs'),
      "export const pipelinePlugins = { p: { name: 'other', build: () => ({}) } };\n",
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a broken file lands in skipped; the good one loads; errors stays empty', async () => {
    const lines: string[] = [];
    const loaded = await new FileSystemPluginLoader({
      dirs: [dir],
      log: (m) => lines.push(m),
    }).load();
    assert.deepEqual(loaded.loadedFiles, [join(dir, 'a-good.mjs')]);
    assert.ok(loaded.reranker, 'the good file registered its reranker');
    assert.deepEqual(loaded.errors, []);
    const skipped = loaded.skipped ?? [];
    assert.deepEqual(
      skipped.map((s) => s.file),
      [join(dir, 'b-broken.mjs'), join(dir, 'c-defect.mjs')],
    );
    assert.match(skipped[0].error, /broken plugin at import/);
    assert.match(skipped[1].error, /pipeline plugin 'p'.*refused/);
    assert.ok(
      lines.some((l) => l.includes('b-broken.mjs')),
      'the skipped file is logged',
    );
  });
});
