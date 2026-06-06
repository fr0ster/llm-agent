import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClarifySignal } from '@mcp-abap-adt/llm-agent';
import { establishTargetState } from '../target-state.js';

const evalClient = (text: string) =>
  ({ send: async () => ({ kind: 'content', content: text }) }) as never;
// IEmbedResult field is `.vector` (confirmed from packages/llm-agent/src/interfaces/rag.ts)
const embedder = (vec: number[]) =>
  ({ embed: async () => ({ vector: vec }) }) as never;

describe('establishTargetState', () => {
  it('semantic-distance: close → returns target state', async () => {
    const ts = await establishTargetState(
      {
        evaluator: evalClient('Goal: review ZTEST'),
        embedder: embedder([1, 0, 0]),
      },
      'review ZTEST',
      { strategy: 'semantic-distance', distanceThreshold: 0.5 },
    );
    assert.equal(ts, 'Goal: review ZTEST');
  });
  it('semantic-distance: far → throws ClarifySignal', async () => {
    let calls = 0;
    const emb = {
      embed: async () => ({ vector: calls++ === 0 ? [1, 0] : [0, 1] }),
    } as never; // orthogonal → distance 1
    await assert.rejects(
      () =>
        establishTargetState(
          { evaluator: evalClient('Goal: X'), embedder: emb },
          'Y',
          { strategy: 'semantic-distance', distanceThreshold: 0.1 },
        ),
      ClarifySignal,
    );
  });
  it('consumer-confirm: always throws ClarifySignal with the formulated target', async () => {
    await assert.rejects(
      () =>
        establishTargetState(
          { evaluator: evalClient('Goal: Z'), embedder: embedder([1]) },
          'p',
          { strategy: 'consumer-confirm', distanceThreshold: 0.25 },
        ),
      (e: unknown) =>
        e instanceof ClarifySignal &&
        /Goal: Z/.test((e as ClarifySignal).question),
    );
  });
});
