/**
 * Spec §17.43 D96: a plugin is required only when the configuration names it.
 * A `plugins: [...]` specifier that cannot be resolved, imported or that
 * registers nothing rejects `start()` naming the specifier and the cause, and
 * a consumer loader's `errors` do too; a discovered file in a plugin directory
 * that fails to load is logged (`plugin_errors`) and the server starts. Every
 * failure of `start()` releases what the start already took before it rejects.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { IRag } from '@mcp-abap-adt/llm-agent';
import {
  emptyLoadedPlugins,
  SmartAgentBuilder,
} from '@mcp-abap-adt/llm-agent-libs';
import type { MakeRagInput } from '../rag-config.js';
import { SmartServer, type SmartServerConfig } from '../smart-server.js';
import { StartReleases } from '../start-releases.js';
import { WorkerRegistry } from '../workers/worker-registry.js';
import { constructionSeams } from './construction-seams.js';

type Events = Record<string, unknown>[];

function baseCfg(events: Events, extra: Partial<SmartServerConfig> = {}) {
  return {
    port: 0,
    host: '127.0.0.1',
    llm: { model: 'stub' },
    skipModelValidation: true,
    log: (e: Record<string, unknown>) => {
      events.push(e);
    },
    ...extra,
  } as unknown as SmartServerConfig;
}

/** True when `port` on 127.0.0.1 can be listened on (nothing holds it). */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Seams that record what the start took. */
function recordingSeams() {
  const taken = { makeRag: 0, connectMcp: 0 };
  return {
    taken,
    deps: {
      ...constructionSeams,
      makeRag: async (input: MakeRagInput): Promise<IRag> => {
        taken.makeRag++;
        return constructionSeams.makeRag(input);
      },
      connectMcpWithDescriptors: async () => {
        taken.connectMcp++;
        return { clients: [], clientDescriptors: [], configuredSlotCount: 0 };
      },
    },
  };
}

const restores: Array<() => void> = [];
afterEach(() => {
  for (const r of restores.splice(0).reverse()) r();
});

describe('SmartServer.start — required plugins (D96)', () => {
  it("plugins: ['./does-not-exist.js'] rejects naming the specifier; nothing is taken, no listener", async () => {
    const events: Events = [];
    const port = await freePort();
    const { taken, deps } = recordingSeams();
    const server = new SmartServer(
      baseCfg(events, {
        port,
        plugins: ['./does-not-exist.js'],
        rag: { store: { type: 'in-memory' } },
        mcp: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
      } as Partial<SmartServerConfig>),
      deps,
    );
    await assert.rejects(server.start(), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(
        e.message,
        /^plugin '\.\/does-not-exist\.js' could not be loaded: /,
      );
      return true;
    });
    assert.deepEqual(taken, { makeRag: 0, connectMcp: 0 });
    assert.equal(await portIsFree(port), true, 'no listener was opened');
  });

  it('a specifier whose module registers nothing rejects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'required-plugin-'));
    try {
      const file = join(dir, 'empty.mjs');
      await writeFile(file, 'export const unrelated = 1;\n');
      const server = new SmartServer(
        baseCfg([], { plugins: [file] }),
        constructionSeams,
      );
      await assert.rejects(
        server.start(),
        new RegExp(
          `plugin '${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' could not be loaded: it exports no plugin registration`,
        ),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a consumer loader's errors entry rejects start(), naming it", async () => {
    const server = new SmartServer(
      baseCfg([], {
        pluginLoader: {
          load: async () => ({
            ...emptyLoadedPlugins(),
            errors: [{ file: 'npm:my-plugin', error: 'not installed' }],
          }),
        },
      }),
      constructionSeams,
    );
    await assert.rejects(
      server.start(),
      /plugin 'npm:my-plugin' could not be loaded: not installed/,
    );
  });

  it('a broken discovered file in pluginDir: the server starts, plugin_errors logged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discovered-plugin-'));
    try {
      await writeFile(
        join(dir, 'broken.mjs'),
        "throw new Error('broken discovered plugin');\n",
      );
      const events: Events = [];
      const server = new SmartServer(
        baseCfg(events, { pluginDir: dir }),
        constructionSeams,
      );
      const handle = await server.start();
      try {
        const logged = events.find((e) => e.event === 'plugin_errors') as
          | { errors: Array<{ file: string; error: string }> }
          | undefined;
        assert.ok(logged, 'plugin_errors is logged');
        const entry = logged.errors.find((x) => x.file.endsWith('broken.mjs'));
        assert.ok(entry);
        assert.match(entry.error, /broken discovered plugin/);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SmartServer.start — a failed start releases what it took (D96)', () => {
  function spyRelease() {
    const seen = { agentClosed: 0, workersDrained: 0, poolEnded: 0 };
    const build = SmartAgentBuilder.prototype.build;
    SmartAgentBuilder.prototype.build = async function (
      this: SmartAgentBuilder,
    ) {
      const handle = await build.call(this);
      const close = handle.close;
      return {
        ...handle,
        close: async () => {
          seen.agentClosed++;
          await close();
        },
      };
    } as typeof build;
    restores.push(() => {
      SmartAgentBuilder.prototype.build = build;
    });
    const drain = WorkerRegistry.prototype.drain;
    WorkerRegistry.prototype.drain = async function (this: WorkerRegistry) {
      seen.workersDrained++;
      return drain.call(this);
    };
    restores.push(() => {
      WorkerRegistry.prototype.drain = drain;
    });
    const pool = {
      end: async () => {
        seen.poolEnded++;
      },
    };
    return { seen, pool };
  }

  it('the port is taken at listen: the startup agent, the workers and the pools are released, then start() rejects', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const addr = blocker.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const { seen, pool } = spyRelease();
      const server = new SmartServer(baseCfg([], { port }), constructionSeams);
      // A pool the start took (as the skill plugin-host's makePgPool records it).
      (server as unknown as { _skillPgPools: unknown[] })._skillPgPools.push(
        pool,
      );
      await assert.rejects(server.start(), /EADDRINUSE/);
      assert.equal(seen.agentClosed, 1, 'the startup agent is closed');
      assert.equal(seen.workersDrained, 1, 'the workers are drained');
      assert.equal(seen.poolEnded, 1, 'the pool is ended');
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('a failure after the workers and the pools were taken releases them, then start() rejects with it', async () => {
    const { seen, pool } = spyRelease();
    const build = SmartAgentBuilder.prototype.build;
    SmartAgentBuilder.prototype.build = async () => {
      throw new Error('builder exploded');
    };
    restores.push(() => {
      SmartAgentBuilder.prototype.build = build;
    });
    const port = await freePort();
    const server = new SmartServer(baseCfg([], { port }), constructionSeams);
    (server as unknown as { _skillPgPools: unknown[] })._skillPgPools.push(
      pool,
    );
    await assert.rejects(server.start(), /builder exploded/);
    assert.equal(seen.workersDrained, 1, 'the workers are drained');
    assert.equal(seen.poolEnded, 1, 'the pool is ended');
    assert.equal(seen.agentClosed, 0, 'no agent was built');
    assert.equal(await portIsFree(port), true, 'no listener was opened');
  });
});

describe('StartReleases — the one release path', () => {
  it('releases newest first; a failing release is logged, never stops the rest', async () => {
    const order: string[] = [];
    const events: Events = [];
    const taken = new StartReleases();
    taken.add('a', () => {
      order.push('a');
    });
    taken.add('b', async () => {
      order.push('b');
      throw new Error('b would not close');
    });
    taken.add('c', () => {
      order.push('c');
    });
    await taken.releaseAll((e) => events.push(e));
    assert.deepEqual(order, ['c', 'b', 'a']);
    assert.deepEqual(events, [
      { event: 'start_release_failed', what: 'b', error: 'b would not close' },
    ]);
    order.length = 0;
    await taken.releaseAll(() => {});
    assert.deepEqual(order, [], 'released once');
  });
});
