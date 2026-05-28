import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
} from '../finalizer.js';

test('IFinalizer contract: minimal happy-path shape compiles', async () => {
  const stub: IFinalizer = {
    name: 'stub',
    async finalize(input: FinalizerInput): Promise<FinalizerResult> {
      return { output: input.interpreterOutput };
    },
  };
  const res = await stub.finalize({
    prompt: 'p',
    objective: 'o',
    interpreterOutput: 'verbatim',
    executionTrace: [{ nodeId: 'n1', goal: 'g', output: 'o1' }],
  });
  assert.equal(res.output, 'verbatim');
  assert.equal(stub.name, 'stub');
});
