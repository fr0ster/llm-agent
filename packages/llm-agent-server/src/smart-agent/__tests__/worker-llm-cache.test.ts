import assert from 'node:assert/strict';
import { test } from 'node:test';
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
