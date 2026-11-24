import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { LlmError, MODEL_CONTEXT_EXCEEDED } from '../interfaces/types.js';
import { collectWithContextOverflow } from './collect-with-context-overflow.js';

for (const returnsError of [false, true]) {
  test(`collection settles on the first ${returnsError ? 'returned' : 'rejected'} overflow with a pending sibling`, async () => {
    const overflow = new LlmError('First overflow', MODEL_CONTEXT_EXCEEDED);
    const later = new LlmError('Later overflow', MODEL_CONTEXT_EXCEEDED);
    const sibling = Promise.withResolvers<Error>();
    const first = Promise.withResolvers<Error>();
    const result = collectWithContextOverflow(
      [
        Promise.reject(new Error('Ordinary rejection')),
        sibling.promise,
        first.promise,
        new Promise<Error>(() => {}),
      ],
      (error) => error,
    );
    if (returnsError) first.resolve(overflow);
    else first.reject(overflow);
    sibling.reject(later);
    assert.deepEqual(await result, { ok: false, error: overflow });
  });
}

test('collection preserves the first ordinary rejection in settlement order', async () => {
  const earlier = new Error('Earlier');
  const later = Promise.withResolvers<string>();
  const pending = Promise.withResolvers<string>();
  const result = collectWithContextOverflow([
    later.promise,
    Promise.reject(earlier),
    pending.promise,
  ]);
  const check = assert.rejects(result, (error) => error === earlier);
  await setImmediate();
  later.reject(new Error('Later'));
  pending.resolve('done');
  await check;
});

test('collection returns successful values in input order', async () => {
  const first = Promise.withResolvers<number>();
  const result = collectWithContextOverflow([
    first.promise,
    Promise.resolve(2),
  ]);
  first.resolve(1);
  assert.deepEqual(await result, { ok: true, value: [1, 2] });
});

test('fail-fast collection preserves the ordinary rejection with a pending sibling', async () => {
  const error = new Error('Ordinary rejection');
  await assert.rejects(
    collectWithContextOverflow(
      [new Promise<number>(() => {}), Promise.reject(error)],
      undefined,
      { rejectImmediately: true },
    ),
    (caught) => caught === error,
  );
});

for (const returnsError of [false, true]) {
  test(
    'collection settles on an abort wrapping overflow with a pending sibling (' +
      (returnsError ? 'returned' : 'rejected') +
      ')',
    async () => {
      const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
      const overflow = Object.assign(
        new LlmError('Context is full', MODEL_CONTEXT_EXCEEDED),
        { usage },
      );
      const abort = Object.assign(new Error('Cancelled', { cause: overflow }), {
        name: 'AbortError',
      });
      const result = await collectWithContextOverflow(
        [
          Promise.reject(new Error('Ordinary failure')),
          new Promise<Error>(() => {}),
          returnsError ? Promise.resolve(abort) : Promise.reject(abort),
        ],
        (error) => error,
      );
      assert.ok(!result.ok);
      assert.equal(result.error.code, 'ABORTED');
      assert.equal(result.error.cause, abort);
      assert.deepEqual(result.error.usage, usage);
    },
  );
}
