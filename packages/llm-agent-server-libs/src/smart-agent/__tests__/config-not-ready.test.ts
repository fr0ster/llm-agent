/**
 * Spec §10.5.10, D82, D82 (8), D82 (9): on a real server, a config change that
 * failed to apply leaves the server not ready — /health 503 naming it, both
 * chat routes 503, a partial PUT 409 — until a whole config applies.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SmartServer } from '../smart-server.js';
import { reloadYaml } from './reload-document.js';
import { httpRequest, makeLlmDeps } from './server-test-helpers.js';

test('D82: a failed PUT leaves the server not ready — /health 503 naming it, both chat routes 503, a partial PUT 409; a whole PUT that applies makes it ready', async () => {
  const server = new SmartServer(
    {
      port: 0,
      llm: { model: 'test-model' },
      skipModelValidation: true,
      agent: { maxIterations: 8 },
    },
    makeLlmDeps(),
  );
  const handle = await server.start();
  const workers = (
    server as unknown as { _workers: { drain(): Promise<void> } }
  )._workers;
  const drain = workers.drain.bind(workers);
  try {
    workers.drain = async () => {
      throw new Error('close failed');
    };
    const failed = await httpRequest(handle.port, 'PUT', '/v1/config', {
      agent: { maxIterations: 25 },
    });
    assert.equal(failed.status, 500);
    const reason = (failed.body as { error: { message: string } }).error
      .message;
    assert.match(reason, /worker drain: Error: close failed/);

    const health = await httpRequest(handle.port, 'GET', '/health');
    assert.equal(health.status, 503);
    const hb = health.body as {
      ready: boolean;
      configNotApplied?: { reason: string; source: string; at: string };
    };
    assert.equal(hb.ready, false);
    assert.equal(hb.configNotApplied?.reason, reason);
    assert.equal(hb.configNotApplied?.source, 'put');

    for (const path of ['/v1/chat/completions', '/v1/messages']) {
      const chat = await httpRequest(handle.port, 'POST', path, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
      });
      assert.equal(chat.status, 503, path);
      const err = (chat.body as { error: { type: string; message: string } })
        .error;
      assert.equal(err.type, 'service_unavailable');
      assert.equal(err.message, `config not applied — ${reason}`);
    }
    assert.equal(
      (await httpRequest(handle.port, 'GET', '/v1/config')).status,
      200,
      'the config routes are not gated',
    );

    // D82 (8): while not ready only the whole config is accepted. This server has
    // no model resolver, so its whole config is `agent`; `{}` misses it.
    const partial = await httpRequest(handle.port, 'PUT', '/v1/config', {});
    assert.equal(partial.status, 409);
    assert.deepEqual((partial.body as { error: unknown }).error, {
      message: 'server not ready — send the whole config: agent',
      type: 'invalid_request_error',
      code: 'config_not_applied',
    });
    assert.equal(
      (
        (await httpRequest(handle.port, 'GET', '/health')).body as {
          configNotApplied?: { reason: string };
        }
      ).configNotApplied?.reason,
      reason,
      'still not ready, the same state',
    );

    workers.drain = drain;
    // The whole config of this server (no model resolver: `agent` alone).
    const ok = await httpRequest(handle.port, 'PUT', '/v1/config', {
      agent: { maxIterations: 30 },
    });
    assert.equal(ok.status, 200);
    const after = (await httpRequest(handle.port, 'GET', '/health')).body as {
      ready: boolean;
      configNotApplied?: unknown;
    };
    assert.equal(after.ready, true);
    assert.equal(after.configNotApplied, undefined);
    const chat = await httpRequest(
      handle.port,
      'POST',
      '/v1/chat/completions',
      {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
      },
    );
    assert.equal(chat.status, 200, 'past the gate: the chat works again');
  } finally {
    workers.drain = drain;
    await handle.close();
  }
});

test('D82: the server starts ready from its config — no configNotApplied at start', async () => {
  const server = new SmartServer(
    { port: 0, llm: { model: 'test-model' }, skipModelValidation: true },
    makeLlmDeps(),
  );
  const handle = await server.start();
  try {
    const body = (await httpRequest(handle.port, 'GET', '/health')).body as {
      ready: boolean;
      configNotApplied?: unknown;
    };
    assert.equal(body.ready, true);
    assert.equal(body.configNotApplied, undefined);
  } finally {
    await handle.close();
  }
});

type HealthBody = {
  ready: boolean;
  configNotApplied?: { reason: string; source: string; at: string };
};

/** `/health` polled until `until` holds (the real watcher debounces file events, 500 ms). */
async function healthWhen(
  port: number,
  until: (b: HealthBody) => boolean,
): Promise<{ status: number; body: HealthBody }> {
  for (let i = 0; i < 100; i++) {
    const h = await httpRequest(port, 'GET', '/health');
    if (until(h.body as HealthBody))
      return { status: h.status, body: h.body as HealthBody };
    await new Promise((r) => setTimeout(r, 50));
  }
  return assert.fail('/health never reached the expected state');
}

/** Both chat routes answer 503 naming `reason` (spec §10.5.10). */
async function assertChatGated(port: number, reason: string): Promise<void> {
  for (const path of ['/v1/chat/completions', '/v1/messages']) {
    const chat = await httpRequest(port, 'POST', path, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    });
    assert.equal(chat.status, 503, path);
    assert.equal(
      (chat.body as { error: { message: string } }).error.message,
      `config not applied — ${reason}`,
    );
  }
}

/** A real server watching a temp `smart-server.yaml` (`cfg.configFile`). */
async function watchedServer(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'config-not-ready-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'smart-server.yaml');
  writeFileSync(configFile, reloadYaml({ maxIterations: 8 })); // a whole config (D83 (10))
  const server = new SmartServer(
    {
      port: 0,
      llm: { model: 'test-model' },
      skipModelValidation: true,
      agent: { maxIterations: 8 },
      configFile,
    },
    makeLlmDeps(),
  );
  return { configFile, handle: await server.start() };
}

const READ_FAILED =
  /^config reload failed, the server is not ready until a whole config applies — cannot read the config file: /;

test('D82 (9): a config file that does not parse → not ready (/health 503, both chat routes 503) until the repaired file applies', async (t) => {
  const { configFile, handle } = await watchedServer(t);
  try {
    writeFileSync(configFile, 'agent:\n  maxIterations: [8\n'); // an unclosed flow sequence: not YAML
    const failed = await healthWhen(
      handle.port,
      (b) => b.configNotApplied !== undefined,
    );
    assert.equal(failed.status, 503);
    assert.equal(failed.body.ready, false);
    assert.equal(failed.body.configNotApplied?.source, 'reload');
    const reason = failed.body.configNotApplied?.reason ?? '';
    assert.match(reason, READ_FAILED);
    await assertChatGated(handle.port, reason);
    // Still broken → still not ready (30.1.0: ready all along, the old config served).
    assert.equal(
      (await httpRequest(handle.port, 'GET', '/health')).status,
      503,
    );
    writeFileSync(configFile, reloadYaml({ maxIterations: 12 }));
    const ok = await healthWhen(
      handle.port,
      (b) => b.configNotApplied === undefined,
    );
    assert.equal(ok.body.ready, true);
    const chat = await httpRequest(
      handle.port,
      'POST',
      '/v1/chat/completions',
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
    );
    assert.equal(chat.status, 200, 'past the gate again');
  } finally {
    await handle.close();
  }
});

test('D82 (9): an unreadable config file (permissions) → not ready until it is readable and applies', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads a 0o000 file');
  const { configFile, handle } = await watchedServer(t);
  try {
    chmodSync(configFile, 0o000); // an attribute change: fs.watch reports it, the read fails (EACCES)
    const failed = await healthWhen(
      handle.port,
      (b) => b.configNotApplied !== undefined,
    );
    assert.equal(failed.status, 503);
    assert.match(failed.body.configNotApplied?.reason ?? '', READ_FAILED);
    assert.match(failed.body.configNotApplied?.reason ?? '', /EACCES/);
    await assertChatGated(
      handle.port,
      failed.body.configNotApplied?.reason ?? '',
    );
    chmodSync(configFile, 0o644);
    writeFileSync(configFile, reloadYaml({ maxIterations: 12 }));
    const ok = await healthWhen(
      handle.port,
      (b) => b.configNotApplied === undefined,
    );
    assert.equal(ok.body.ready, true);
  } finally {
    chmodSync(configFile, 0o644);
    await handle.close();
  }
});

test('D82 (9): a deleted config file → not ready until a whole config applies (a whole PUT)', async (t) => {
  const { configFile, handle } = await watchedServer(t);
  try {
    rmSync(configFile);
    const failed = await healthWhen(
      handle.port,
      (b) => b.configNotApplied !== undefined,
    );
    assert.equal(failed.status, 503);
    assert.match(failed.body.configNotApplied?.reason ?? '', READ_FAILED);
    assert.match(failed.body.configNotApplied?.reason ?? '', /ENOENT/);
    await assertChatGated(
      handle.port,
      failed.body.configNotApplied?.reason ?? '',
    );
    assert.equal(
      (await httpRequest(handle.port, 'PUT', '/v1/config', {})).status,
      409,
      'a partial PUT is refused',
    );
    // This server has no model resolver: its whole config is `agent`.
    assert.equal(
      (
        await httpRequest(handle.port, 'PUT', '/v1/config', {
          agent: { maxIterations: 30 },
        })
      ).status,
      200,
    );
    const ok = (await httpRequest(handle.port, 'GET', '/health'))
      .body as HealthBody;
    assert.equal(ok.ready, true);
    assert.equal(ok.configNotApplied, undefined);
  } finally {
    await handle.close();
  }
});
