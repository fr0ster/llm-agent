import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpClient, IRag } from '@mcp-abap-adt/llm-agent';
import { resolveWorkerLlmSet, type WorkerLlmSet } from '../smart-server.js';

// A worker LLM set is built ONCE per worker name and reused by reference on
// subsequent (per-session) calls — never reconstructed. The factory counts how
// many times it actually constructs an LLM.
test('resolveWorkerLlmSet builds once per worker and returns the cached set by reference', async () => {
  let built = 0;
  const cache = new Map<string, WorkerLlmSet>();
  // biome-ignore lint/suspicious/noExplicitAny: test stub for ILlm
  const fakeMake = async (): Promise<any> => {
    built++;
    return {};
  };

  const first = await resolveWorkerLlmSet({
    name: 'w',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });
  const second = await resolveWorkerLlmSet({
    name: 'w',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });

  assert.equal(first, second, 'same cached set instance returned by reference');
  assert.equal(first.mainLlm, second.mainLlm, 'main LLM not rebuilt');
  assert.equal(
    first.classifierLlm,
    second.classifierLlm,
    'classifier LLM not rebuilt',
  );
  assert.equal(
    built,
    2,
    'exactly two constructions total (main + classifier), once — NOT per call',
  );
});

test('resolveWorkerLlmSet builds once per distinct worker name', async () => {
  let built = 0;
  const cache = new Map<string, WorkerLlmSet>();
  // biome-ignore lint/suspicious/noExplicitAny: test stub for ILlm
  const fakeMake = async (): Promise<any> => {
    built++;
    return {};
  };

  const w1a = await resolveWorkerLlmSet({
    name: 'w1',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });
  const w2a = await resolveWorkerLlmSet({
    name: 'w2',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });
  const w1b = await resolveWorkerLlmSet({
    name: 'w1',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });

  assert.equal(w1a, w1b, 'w1 cached by reference across calls');
  assert.notEqual(w1a, w2a, 'distinct names yield distinct sets');
  assert.equal(built, 4, '2 builds per worker × 2 distinct workers');
});

test('resolveWorkerLlmSet caches worker-OWN toolsRag/historyRag/mcpClients and reuses them by reference (review HIGH #1)', async () => {
  let toolsBuilt = 0;
  let historyBuilt = 0;
  let mcpBuilt = 0;
  const cache = new Map<string, WorkerLlmSet>();
  // biome-ignore lint/suspicious/noExplicitAny: test stub for ILlm
  const fakeMake = async (): Promise<any> => ({});
  const makeToolsRag = async (): Promise<IRag> => {
    toolsBuilt++;
    return {} as IRag;
  };
  const makeHistoryRag = async (): Promise<IRag> => {
    historyBuilt++;
    return {} as IRag;
  };
  const makeMcpClients = async (): Promise<IMcpClient[]> => {
    mcpBuilt++;
    return [{} as IMcpClient];
  };

  const a = await resolveWorkerLlmSet({
    name: 'w',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
    makeToolsRag,
    makeHistoryRag,
    makeMcpClients,
  });
  const b = await resolveWorkerLlmSet({
    name: 'w',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
    makeToolsRag,
    makeHistoryRag,
    makeMcpClients,
  });

  assert.equal(a, b, 'cached set returned by reference');
  assert.equal(a.toolsRag, b.toolsRag, 'toolsRag reused by reference');
  assert.equal(a.historyRag, b.historyRag, 'historyRag reused by reference');
  assert.equal(a.mcpClients, b.mcpClients, 'mcpClients reused by reference');
  assert.equal(toolsBuilt, 1, 'toolsRag built exactly once');
  assert.equal(historyBuilt, 1, 'historyRag built exactly once');
  assert.equal(mcpBuilt, 1, 'mcpClients built exactly once');
});

test('worker WITHOUT own toolsRag/MCP factories leaves those cache slots undefined (re-wire falls back to injected)', async () => {
  const cache = new Map<string, WorkerLlmSet>();
  // biome-ignore lint/suspicious/noExplicitAny: test stub for ILlm
  const fakeMake = async (): Promise<any> => ({});
  const set = await resolveWorkerLlmSet({
    name: 'lean',
    cache,
    makeMain: fakeMake,
    makeClassifier: fakeMake,
  });
  assert.equal(
    set.toolsRag,
    undefined,
    'no makeToolsRag factory → cached.toolsRag undefined → re-wire falls back to injected',
  );
  assert.equal(set.historyRag, undefined);
  assert.equal(set.mcpClients, undefined);
});
