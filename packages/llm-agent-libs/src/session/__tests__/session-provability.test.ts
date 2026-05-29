import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionRequestLogger } from '../../logger/session-request-logger.js';
import { PendingToolResultsRegistry } from '../../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../../policy/tool-availability-registry.js';
import { SessionGraph } from '../session-graph.js';
import { SessionRegistry } from '../session-registry.js';

function factory(disposed: string[]) {
  return {
    build: async (id: { sessionId: string }) =>
      new SessionGraph({
        sessionId: id.sessionId,
        toolAvailability: new ToolAvailabilityRegistry(),
        pendingToolResults: new PendingToolResultsRegistry(),
        logger: new SessionRequestLogger(),
        dispose: async (s) => {
          disposed.push(s);
        },
      }),
  };
}

test('two sessions get distinct graphs (no shared default bucket)', async () => {
  const reg = new SessionRegistry({
    idleTtlMs: 10_000,
    maxSessions: 100,
    factory: factory([]),
  });
  const a = await reg.acquire('s1');
  reg.release('s1');
  const b = await reg.acquire('s2');
  reg.release('s2');
  assert.notEqual(a, b);
});

test('evict triggers dispose exactly once per session', async () => {
  const disposed: string[] = [];
  const reg = new SessionRegistry({
    idleTtlMs: 0,
    maxSessions: 100,
    factory: factory(disposed),
  });
  await reg.acquire('s1');
  reg.release('s1');
  await reg.evictIdle();
  await reg.evictIdle();
  assert.deepEqual(disposed, ['s1']);
});
