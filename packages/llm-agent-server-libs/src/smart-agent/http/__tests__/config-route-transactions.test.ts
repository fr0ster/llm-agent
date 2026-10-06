/**
 * Spec §10.5.9 V10, D80 (extended) and D82 (decided by the user on
 * 2026-10-06): PUT /v1/config runs as one transaction in the server's config
 * queue — the queue the file reload uses. A failed apply, drain or
 * invalidation answers 500, restores nothing and leaves the server not ready
 * (the queue's notApplied) until a whole config applies — while it is not
 * ready a partial PUT is refused with 409 and changes nothing (D82 (8)). The
 * harness has a model resolver, so the whole config is `models` + `agent`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '@mcp-abap-adt/llm-agent-libs';
import {
  FLAT_PIPELINE,
  reloadDocument,
} from '../../__tests__/reload-document.js';
import {
  deferred,
  jsonRequest,
  recordingResponse,
} from '../../__tests__/server-test-helpers.js';
import { ConfigReloadWatcher } from '../../config-reload-watcher.js';
import { ConfigTransactionQueue } from '../../config-transaction-queue.js';
import {
  handleConfigUpdate,
  type IConfigUpdateTarget,
} from '../config-route-handler.js';

/** Enough turns for a request body to stream in and a queued transaction to start. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
}

const FAILED =
  /^config update failed, the server is not ready until a whole config applies — /;
/** D82 (8): the 409 a partial PUT gets while the server is not ready. */
function assertRefused(
  reply: { status?: number; body?: string },
  missing: string,
): void {
  assert.equal(reply.status, 409);
  const error = JSON.parse(reply.body ?? '{}').error;
  assert.equal(error.type, 'invalid_request_error');
  assert.equal(error.code, 'config_not_applied');
  assert.equal(
    error.message,
    `server not ready — send the whole config: ${missing}`,
  );
}

/**
 * One server's state, reached by both paths: the startup agent's config, the
 * server's mirror (`cfg.agent`) and its held main LLM. Every drain — the
 * reload's and the PUT's — is a fresh deferred in `drains`.
 * `failReconfigure` makes the startup agent's `reconfigure` throw (30.1.0's
 * `reconfigure`, unchanged).
 */
function harness(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'config-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'smart-server.yaml');
  writeFileSync(configFile, 'agent:\n  maxIterations: 10\n');
  const queue = new ConfigTransactionQueue();
  const state = {
    agent: { maxIterations: 10 } as Record<string, unknown>,
    mirror: { maxIterations: 10 } as Record<string, unknown>,
    heldMain: { model: 'm0' } as unknown as ILlm,
  };
  const agentCalls: string[] = [];
  const drains: ReturnType<typeof deferred>[] = [];
  const drainWorkers = () => {
    const d = deferred();
    drains.push(d);
    return d.promise;
  };
  let invalidate: () => Promise<void> = async () => {};
  let reconfigureError: Error | undefined;
  const agent = {
    applyConfigUpdate: (patch: Record<string, unknown>) => {
      agentCalls.push('applyConfigUpdate');
      state.agent = { ...state.agent, ...patch };
    },
    reconfigure: () => {
      agentCalls.push('reconfigure');
      if (reconfigureError) throw reconfigureError;
    },
    getActiveConfig: () => ({ mainModel: state.heldMain.model }),
    getAgentConfig: () => ({ ...state.agent }),
  } as unknown as SmartAgent;
  const target: IConfigUpdateTarget = {
    modelResolver: {
      resolve: async (name: string) => ({ model: name }) as unknown as ILlm,
    },
    skipModelValidation: true,
    setMainLlm: (llm) => {
      state.heldMain = llm;
      return llm;
    },
    setClassifierLlm: (llm) => llm,
    setHelperLlm: (llm) => llm,
    mirrorAgentCfg: (patch) => {
      state.mirror = { ...state.mirror, ...patch };
    },
    drainWorkers,
    invalidateSessions: () => invalidate(),
    transactions: queue,
  };
  const events: Record<string, unknown>[] = [];
  const watcher = new ConfigReloadWatcher({
    configFile,
    log: (e) => {
      events.push(e);
    },
    applyAgentUpdate: (u) => {
      state.agent = { ...state.agent, ...u };
    },
    mirrorCfg: (patch) => {
      state.mirror = { ...state.mirror, ...patch };
    },
    drainWorkers,
    invalidateSessions: async () => {},
    ragStores: {},
    transactions: queue,
    pipeline: FLAT_PIPELINE, // D83 (11)
  });
  // White-box: the watcher's reload entry point (D39), with a whole document
  // holding `u` (D83 (10): a reload applies only a document the server could start from).
  const reload = (u: Record<string, unknown>) =>
    (
      watcher as unknown as { _onReload(document: unknown): Promise<void> }
    )._onReload(reloadDocument(u));
  // White-box: what the `error` listener queues (D82 (9)) — the real listener is
  // driven by config-not-ready.test.ts over a real file.
  const watcherError = (err: unknown) =>
    (
      watcher as unknown as { _onWatcherError(e: unknown): Promise<void> }
    )._onWatcherError(err);
  /** A PUT through the real handler: a streamed JSON body, a recording response. */
  const put = (body: unknown) => {
    const { reply, res } = recordingResponse();
    return {
      reply,
      done: handleConfigUpdate(
        jsonRequest(JSON.stringify(body)),
        res,
        agent,
        target,
      ),
    };
  };
  /** `undefined` makes the invalidation succeed again. */
  const failInvalidation = (err: Error | undefined) => {
    invalidate = err
      ? async () => {
          throw err;
        }
      : async () => {};
  };
  const failReconfigure = (err: Error | undefined) => {
    reconfigureError = err;
  };
  return {
    state,
    queue,
    agentCalls,
    drains,
    events,
    reload,
    watcherError,
    put,
    failInvalidation,
    failReconfigure,
  };
}

test('D80/V10, D82 (8): PUTs wait for a reload in flight; the reload fails after they were queued → the reload reported, the partial PUT refused at its start, the whole PUT applied and the server ready', async (t) => {
  const h = harness(t);
  const a = h.reload({ maxIterations: 25 });
  const partial = h.put({ agent: { maxIterations: 33 } });
  const whole = h.put({
    models: { mainModel: 'm1' },
    agent: { maxIterations: 40 },
  });
  await settle();
  assert.equal(
    h.drains.length,
    1,
    'no PUT has started while the reload is in flight',
  );
  assert.equal(h.state.mirror.maxIterations, 25, "the reload's config");
  h.drains[0].reject(new Error('close failed'));
  await assert.rejects(a, /worker drain: Error: close failed/);
  // Both passed the first check while the server was ready; the queue decides at each start.
  await partial.done;
  assertRefused(partial.reply, 'models');
  // The whole PUT may already be applying (its drain pending); the partial one's 33 never lands.
  assert.notEqual(
    h.state.mirror.maxIterations,
    33,
    'the refused PUT applied nothing',
  );
  assert.notEqual(h.state.agent.maxIterations, 33);
  assert.equal(
    h.queue.notApplied?.source,
    'reload',
    'still the failed reload: not ready',
  );
  await settle();
  assert.equal(
    h.drains.length,
    2,
    'only the whole PUT drained, after the reload settled',
  );
  h.drains[1].resolve();
  await whole.done;
  assert.equal(whole.reply.status, 200);
  assert.equal(JSON.parse(whole.reply.body ?? '{}').agent.maxIterations, 40);
  assert.equal(h.state.mirror.maxIterations, 40);
  assert.equal(h.state.agent.maxIterations, 40);
  assert.equal(h.state.heldMain.model, 'm1');
  assert.equal(
    h.queue.notApplied,
    undefined,
    'the whole PUT applied — ready again',
  );
});

test('D82 (8): a failed PUT → not ready; a reload (the whole file) → ready', async (t) => {
  const h = harness(t);
  const a = h.put({ agent: { maxIterations: 25 } });
  await settle();
  h.drains[0].reject(new Error('close failed'));
  await a.done;
  assert.equal(a.reply.status, 500);
  assert.equal(h.queue.notApplied?.source, 'put');
  const b = h.reload({ maxIterations: 40 });
  await settle();
  h.drains[1].resolve();
  await b;
  assert.equal(h.state.mirror.maxIterations, 40);
  assert.equal(
    h.queue.notApplied,
    undefined,
    'a reload re-reads the whole file: ready',
  );
});

test('D80/V10: a reload waits for a PUT in flight; the PUT fails → 500, then the reload applied and the server ready', async (t) => {
  const h = harness(t);
  const a = h.put({ agent: { maxIterations: 25 } });
  await settle();
  assert.equal(h.drains.length, 1, "the PUT's drain is pending");
  const b = h.reload({ maxIterations: 40 });
  await settle();
  assert.equal(h.drains.length, 1, 'the reload waits for the PUT');
  h.drains[0].reject(new Error('close failed'));
  await a.done;
  assert.equal(a.reply.status, 500);
  await settle();
  assert.equal(
    h.drains.length,
    2,
    'the reload started only after the PUT settled',
  );
  h.drains[1].resolve();
  await b;
  assert.equal(h.state.mirror.maxIterations, 40, "the reload's config is live");
  assert.equal(h.state.agent.maxIterations, 40);
  assert.equal(
    h.events.filter((e) => e.event === 'config_reload_applied').length,
    1,
  );
  assert.equal(h.queue.notApplied, undefined);
});

test('V10/D82: a PUT whose worker drain fails → 500 server_error naming it; nothing restored; not ready', async (t) => {
  const h = harness(t);
  const a = h.put({
    models: { mainModel: 'm1' },
    agent: { maxIterations: 25 },
  });
  await settle();
  h.drains[0].reject(new Error('close failed'));
  await a.done;
  assert.equal(a.reply.status, 500);
  const error = JSON.parse(a.reply.body ?? '{}').error;
  assert.equal(error.type, 'server_error');
  assert.match(error.message, FAILED);
  assert.match(error.message, /worker drain: Error: close failed$/);
  // No rollback (D82): what the transaction applied stays applied.
  assert.equal(h.state.mirror.maxIterations, 25);
  assert.equal(h.state.heldMain.model, 'm1');
  assert.deepEqual(
    h.agentCalls,
    ['reconfigure', 'applyConfigUpdate'],
    "the startup agent updated in 30.1.0's order, before the drain",
  );
  assert.equal(h.queue.notApplied?.source, 'put');
  assert.equal(h.queue.notApplied?.reason, error.message);
});

test('V10/D82: a PUT whose session invalidation fails → 500 naming it; not ready', async (t) => {
  const h = harness(t);
  h.failInvalidation(new Error('dispose failed'));
  const a = h.put({ agent: { maxIterations: 25 } });
  await settle();
  h.drains[0].resolve();
  await a.done;
  assert.equal(a.reply.status, 500);
  assert.match(
    JSON.parse(a.reply.body ?? '{}').error.message,
    /session invalidation: Error: dispose failed/,
  );
  assert.equal(h.state.mirror.maxIterations, 25, 'not restored');
  assert.match(h.queue.notApplied?.reason ?? '', /session invalidation/);
});

test("V10/D82: a PUT whose startup-agent reconfigure throws → 500 'apply: …', the drain never run, not ready; the next PUT applies and the server is ready", async (t) => {
  const h = harness(t);
  h.failReconfigure(new Error('pipeline swap failed'));
  const a = h.put({
    models: { mainModel: 'm1' },
    agent: { maxIterations: 25 },
  });
  await settle();
  await a.done;
  assert.equal(a.reply.status, 500);
  const error = JSON.parse(a.reply.body ?? '{}').error;
  assert.equal(error.type, 'server_error');
  assert.match(error.message, FAILED);
  assert.match(error.message, /apply: Error: pipeline swap failed$/);
  assert.equal(h.drains.length, 0, 'a failed apply runs no drain');
  assert.equal(
    h.state.heldMain.model,
    'm1',
    'the held model stays — no rollback',
  );
  assert.deepEqual(
    h.agentCalls,
    ['reconfigure'],
    'applyConfigUpdate not reached',
  );
  assert.equal(h.queue.notApplied?.source, 'put');
  // The consumer sends another config; the first one that applies makes the server ready.
  h.failReconfigure(undefined);
  const b = h.put({
    models: { mainModel: 'm2' },
    agent: { maxIterations: 40 },
  });
  await settle();
  h.drains[0].resolve();
  await b.done;
  assert.equal(b.reply.status, 200);
  assert.deepEqual(JSON.parse(b.reply.body ?? '{}'), {
    models: { mainModel: 'm2' },
    agent: { maxIterations: 40 },
  });
  assert.equal(h.queue.notApplied, undefined);
});

test('V10: a successful PUT → 200 with its config; the startup agent updated before the drain (30.1.0 order, pinned); ready', async (t) => {
  const h = harness(t);
  const a = h.put({
    models: { mainModel: 'm1' },
    agent: { maxIterations: 25 },
  });
  await settle();
  assert.deepEqual(h.agentCalls, ['reconfigure', 'applyConfigUpdate']);
  assert.equal(h.drains.length, 1);
  h.drains[0].resolve();
  await a.done;
  assert.equal(a.reply.status, 200);
  assert.deepEqual(JSON.parse(a.reply.body ?? '{}'), {
    models: { mainModel: 'm1' },
    agent: { maxIterations: 25 },
  });
  assert.equal(h.state.mirror.maxIterations, 25);
  assert.equal(h.queue.notApplied, undefined);
});

test('D82 (8): while not ready a partial PUT is refused (409) and changes nothing; a 400 too; a whole PUT makes it ready', async (t) => {
  const h = harness(t);
  h.failInvalidation(new Error('dispose failed'));
  const failed = h.put({ agent: { maxIterations: 25 } });
  await settle();
  h.drains[0].resolve();
  await failed.done;
  assert.equal(failed.reply.status, 500);
  const before = h.queue.notApplied;
  assert.ok(before, 'the failed PUT left the server not ready');
  h.failInvalidation(undefined);
  for (const [body, missing] of [
    [{}, 'models, agent'],
    [{ agent: { maxIterations: 30 } }, 'models'],
    [{ models: { mainModel: 'm9' } }, 'agent'],
    [{ models: { mainModel: 'm9' }, agent: {} }, 'agent'],
  ] as const) {
    const r = h.put(body);
    await r.done;
    assertRefused(r.reply, missing);
  }
  assert.equal(h.drains.length, 1, 'no refused PUT ran a transaction');
  assert.equal(h.state.mirror.maxIterations, 25, 'nothing applied');
  assert.equal(h.state.heldMain.model, 'm0', 'no model held');
  assert.equal(h.queue.notApplied, before, 'still not ready, the same state');
  const rejected = h.put({
    models: { mainModel: 'm1' },
    agent: { notAField: 1 },
  });
  await rejected.done;
  assert.equal(
    rejected.reply.status,
    400,
    'a malformed whole PUT is a 400 as before',
  );
  assert.equal(h.queue.notApplied, before);
  const whole = h.put({
    models: { mainModel: 'm1' },
    agent: { maxIterations: 30 },
  });
  await settle();
  h.drains[1].resolve();
  await whole.done;
  assert.equal(whole.reply.status, 200);
  assert.equal(
    h.queue.notApplied,
    undefined,
    'the whole config applied: ready',
  );
});

test('D82 (9): a watcher error is a failed reload in queue order — after the PUT in flight, before the PUT queued behind it', async (t) => {
  const h = harness(t);
  const first = h.put({
    models: { mainModel: 'm1' },
    agent: { maxIterations: 30 },
  });
  await settle();
  assert.equal(h.drains.length, 1, 'the first PUT is applying');
  const unreadable = h.watcherError(
    new Error('Nested mappings are not allowed in compact mappings'),
  );
  const partial = h.put({ agent: { maxIterations: 33 } });
  await settle();
  assert.equal(
    h.queue.notApplied,
    undefined,
    'the error waits for the PUT in flight',
  );
  h.drains[0].resolve();
  await first.done;
  assert.equal(first.reply.status, 200);
  await assert.rejects(
    unreadable,
    /^Error: config reload failed, the server is not ready until a whole config applies — cannot read the config file: Nested mappings are not allowed/,
  );
  assert.equal(h.queue.notApplied?.source, 'reload');
  assert.match(h.queue.notApplied?.reason ?? '', /cannot read the config file/);
  // Queued while ready, behind the error: refused when it starts (D82 (8)).
  await partial.done;
  assertRefused(partial.reply, 'models');
  assert.equal(
    h.state.mirror.maxIterations,
    30,
    "the first PUT's config; the error applied nothing",
  );
  assert.equal(h.drains.length, 1, 'the error ran no drain');
  const whole = h.put({
    models: { mainModel: 'm2' },
    agent: { maxIterations: 40 },
  });
  await settle();
  h.drains[1].resolve();
  await whole.done;
  assert.equal(whole.reply.status, 200);
  assert.equal(h.queue.notApplied, undefined, 'a whole config applied: ready');
});

test('D82 (8): while ready a partial PUT works as before, and one that names nothing answers 200 outside the queue', async (t) => {
  const h = harness(t);
  const partial = h.put({ agent: { maxIterations: 25 } });
  await settle();
  h.drains[0].resolve();
  await partial.done;
  assert.equal(partial.reply.status, 200);
  assert.equal(h.state.mirror.maxIterations, 25);
  const empty = h.put({});
  await empty.done;
  assert.equal(
    empty.reply.status,
    200,
    'nothing to change: the live config, outside the queue',
  );
  assert.equal(h.drains.length, 1, 'no transaction ran');
  assert.equal(h.queue.notApplied, undefined);
});

test('V10: a model probe that REJECTS answers 400 naming the model, as a probe that returns ok:false — nothing applied, the server ready', async () => {
  const queue = new ConfigTransactionQueue();
  const applied: string[] = [];
  const agent = {
    applyConfigUpdate: () => {
      applied.push('applyConfigUpdate');
    },
    reconfigure: () => {
      applied.push('reconfigure');
    },
    getActiveConfig: () => ({}),
    getAgentConfig: () => ({}),
  } as unknown as SmartAgent;
  const target: IConfigUpdateTarget = {
    modelResolver: {
      resolve: async () =>
        ({
          chat: () => Promise.reject(new Error('connect ECONNREFUSED')),
        }) as unknown as ILlm,
    },
    setMainLlm: (llm) => {
      applied.push('setMainLlm');
      return llm;
    },
    setClassifierLlm: (llm) => llm,
    setHelperLlm: (llm) => llm,
    mirrorAgentCfg: () => {
      applied.push('mirrorAgentCfg');
    },
    drainWorkers: async () => {},
    invalidateSessions: async () => {},
    transactions: queue,
  };
  const { reply, res } = recordingResponse();
  await handleConfigUpdate(
    jsonRequest(JSON.stringify({ models: { mainModel: 'gone-model' } })),
    res,
    agent,
    target,
  );
  assert.equal(reply.status, 400);
  const error = JSON.parse(reply.body ?? '{}').error;
  assert.equal(error.type, 'invalid_request_error');
  assert.equal(
    error.message,
    'model "gone-model" is not available: connect ECONNREFUSED',
  );
  assert.deepEqual(applied, []);
  assert.equal(queue.notApplied, undefined);
});
