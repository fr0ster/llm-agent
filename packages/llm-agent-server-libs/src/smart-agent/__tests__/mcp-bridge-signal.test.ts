import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IMcpClient,
  IMcpFailureClassifier,
} from '@mcp-abap-adt/llm-agent';
import { buildMcpBridge } from '../smart-server.js';

test('buildMcpBridge forwards the signal into listTools + callTool', async () => {
  const seen: { list?: AbortSignal; call?: AbortSignal } = {};
  const client = {
    listTools: async (opts?: { signal?: AbortSignal }) => {
      seen.list = opts?.signal;
      return {
        ok: true,
        value: [{ name: 'T', description: '', inputSchema: {} }],
      };
    },
    callTool: async (
      _n: string,
      _a: unknown,
      opts?: { signal?: AbortSignal },
    ) => {
      seen.call = opts?.signal;
      return { ok: true, value: { content: 'r' } };
    },
  } as unknown as IMcpClient;
  const ctrl = new AbortController();
  await buildMcpBridge([client])('T', {}, ctrl.signal);
  assert.equal(seen.list, ctrl.signal);
  assert.equal(seen.call, ctrl.signal);
});

test('buildMcpBridge threads the signal into the classifier health probe', async () => {
  let probeCalled = false;
  let probeOpts: { signal?: AbortSignal } | undefined;
  const client = {
    listTools: async () => ({
      ok: false,
      error: { code: 'net', message: 'down' },
    }),
    callTool: async () => ({ ok: true, value: { content: 'r' } }),
    healthCheck: async (options?: { signal?: AbortSignal }) => {
      probeCalled = true;
      probeOpts = options;
      return { ok: true, value: true };
    },
  } as unknown as IMcpClient;
  // Custom classifier that AWAITS the probe (so the probe actually fires) and
  // then reports a tool-level error → loop continues, no throw.
  const classifier: IMcpFailureClassifier = {
    classify: async (_err, probe) => {
      if (probe) await probe();
      return 'tool-error';
    },
  };
  const ctrl = new AbortController();
  await buildMcpBridge([client], classifier)('T', {}, ctrl.signal);
  assert.ok(probeCalled, 'health probe should have fired');
  assert.ok(probeOpts, 'healthCheck must be called with an options arg');
  assert.equal(probeOpts?.signal, ctrl.signal);
});
