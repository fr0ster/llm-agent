import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IStateOracle,
  StateOracleInput,
  StateOracleResult,
} from '../state-oracle.js';

test('IStateOracle contract: minimal shape compiles and answers', async () => {
  const stub: IStateOracle = {
    name: 'stub',
    async query(input: StateOracleInput): Promise<StateOracleResult> {
      return { answer: `you asked: ${input.query}` };
    },
  };
  const res = await stub.query({ query: 'who am i' });
  assert.equal(res.answer, 'you asked: who am i');
  assert.equal(res.usage, undefined);
});
