/**
 * Spec §10.5.8 S-6 (amended by §17.43 D96): `build()` fails on
 * `LoadedPlugins.errors` — the plugins the loader was told to load — and only
 * on them. A discovered file that did not load (`skipped`) is logged through
 * the builder's logger and never fails the build.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LogEvent } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import { FileSystemPluginLoader } from '../plugins/loader.js';
import { emptyLoadedPlugins } from '../plugins/types.js';
import { makeLlm } from '../testing/index.js';

describe('SmartAgentBuilder — required plugins only (D96, S-6 amended)', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'builder-plugins-'));
    await writeFile(
      join(dir, 'a-good.mjs'),
      'export const reranker = { rerank: async (_q, r) => ({ ok: true, value: r }) };\n',
    );
    await writeFile(
      join(dir, 'b-broken.mjs'),
      "throw new Error('broken plugin at import');\n",
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a broken discovered file: build() succeeds and logs the skipped file', async () => {
    const events: LogEvent[] = [];
    const handle = await new SmartAgentBuilder({})
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .withLogger({ log: (e) => events.push(e) })
      .withPluginLoader(new FileSystemPluginLoader({ dirs: [dir] }))
      .build();
    try {
      const warning = events.find(
        (e) =>
          e.type === 'warning' &&
          'message' in e &&
          e.message.includes('b-broken.mjs'),
      );
      assert.ok(warning, 'the skipped file is logged as a warning');
      assert.match(
        (warning as { message: string }).message,
        /broken plugin at import/,
      );
    } finally {
      await handle.close();
    }
  });

  it('a consumer loader that returns an errors entry fails build(), naming it', async () => {
    const b = new SmartAgentBuilder({})
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .withPluginLoader({
        load: async () => ({
          ...emptyLoadedPlugins(),
          errors: [{ file: 'required-plugin', error: 'not found' }],
          skipped: [{ file: 'discovered.js', error: 'ignored' }],
        }),
      });
    await assert.rejects(b.build(), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /required-plugin: not found/);
      assert.doesNotMatch(e.message, /discovered\.js/);
      return true;
    });
  });

  it('a failed required plugin releases the MCP connection build() already took', async () => {
    let disposed = 0;
    const b = new SmartAgentBuilder({})
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .withMcpConnectionStrategy({
        resolve: async () => ({ clients: [], toolsChanged: false }),
        dispose: () => {
          disposed++;
        },
      })
      .withPluginLoader({
        load: async () => ({
          ...emptyLoadedPlugins(),
          errors: [{ file: 'required-plugin', error: 'not found' }],
        }),
      });
    await assert.rejects(b.build(), /required-plugin: not found/);
    assert.equal(disposed, 1, 'the connection strategy is disposed');
  });
});
