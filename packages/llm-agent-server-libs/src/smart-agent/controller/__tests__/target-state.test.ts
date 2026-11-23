import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MODEL_CONTEXT_EXCEEDED,
  RagError,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import type { ISubagentClient } from '../subagent-client.js';
import { establishTargetState } from '../target-state.js';

const evalClient = (text: string): ISubagentClient => ({
  send: async () => ({ kind: 'content', content: text }),
});
// IEmbedResult field is `.vector` (confirmed from packages/llm-agent/src/interfaces/rag.ts)
const embedder = (vec: number[]) =>
  symmetricEmbedder({ embed: async () => ({ vector: vec }) });

describe('establishTargetState', () => {
  it('semantic-distance: close → established with the target as goal', async () => {
    const outcome = await establishTargetState(
      {
        evaluator: evalClient('Goal: review ZTEST'),
        embedder: embedder([1, 0, 0]),
      },
      'review ZTEST',
      { strategy: 'semantic-distance', distanceThreshold: 0.5 },
    );
    assert.equal(outcome.kind, 'established');
    assert.equal(
      outcome.kind === 'established' && outcome.goal,
      'Goal: review ZTEST',
    );
  });
  it('semantic-distance: far → needs-confirmation carrying the proposed target', async () => {
    let calls = 0;
    const emb = symmetricEmbedder({
      embed: async () => ({ vector: calls++ === 0 ? [1, 0] : [0, 1] }),
    }); // orthogonal → distance 1
    const outcome = await establishTargetState(
      { evaluator: evalClient('Goal: X'), embedder: emb },
      'Y',
      { strategy: 'semantic-distance', distanceThreshold: 0.1 },
    );
    assert.equal(outcome.kind, 'needs-confirmation');
    assert.equal(
      outcome.kind === 'needs-confirmation' && outcome.proposedTarget,
      'Goal: X',
    );
  });
  it('consumer-confirm: needs-confirmation with the formulated target', async () => {
    const outcome = await establishTargetState(
      { evaluator: evalClient('Goal: Z'), embedder: embedder([1]) },
      'p',
      { strategy: 'consumer-confirm', distanceThreshold: 0.25 },
    );
    assert.equal(outcome.kind, 'needs-confirmation');
    assert.ok(
      outcome.kind === 'needs-confirmation' &&
        outcome.proposedTarget === 'Goal: Z' &&
        /Goal: Z/.test(outcome.question),
    );
  });
  it('consumer-confirm: needs no embedder', async () => {
    const outcome = await establishTargetState(
      { evaluator: evalClient('Goal: no-embed') },
      'p',
      { strategy: 'consumer-confirm', distanceThreshold: 0.25 },
    );
    assert.equal(outcome.kind, 'needs-confirmation');
  });

  const distanceStrategies: ('semantic-distance' | 'auto')[] = [
    'semantic-distance',
    'auto',
  ];
  for (const strategy of distanceStrategies) {
    it(`${strategy}: gives context overflow priority over an ordinary rejection`, async () => {
      const ordinary = new Error('Embedding failed');
      const overflow = new RagError('Context is full', MODEL_CONTEXT_EXCEEDED);
      const embedder = symmetricEmbedder({
        async embed(text) {
          if (text === 'goal') throw ordinary;
          await Promise.resolve();
          throw overflow;
        },
      });
      await assert.rejects(
        establishTargetState(
          { evaluator: evalClient('goal'), embedder },
          'prompt',
          {
            strategy,
            distanceThreshold: 0.5,
          },
        ),
        (error) => error === overflow,
      );
    });
  }

  it('propagates an ordinary embedding rejection unchanged', async () => {
    const failure = new Error('Embedding failed');
    const embedder = symmetricEmbedder({
      async embed(text) {
        if (text === 'goal') throw failure;
        return { vector: [1] };
      },
    });
    await assert.rejects(
      establishTargetState(
        { evaluator: evalClient('goal'), embedder },
        'prompt',
        {
          strategy: 'semantic-distance',
          distanceThreshold: 0.5,
        },
      ),
      (error) => error === failure,
    );
  });
});
