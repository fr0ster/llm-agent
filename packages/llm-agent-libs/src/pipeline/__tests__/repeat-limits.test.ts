import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDefaultDeps, testCallOptions } from '../../testing/index.js';
import { NoopTracer } from '../../tracer/noop-tracer.js';
import { DefaultPipeline } from '../default-pipeline.js';
import { PipelineExecutor } from '../executor.js';
import type { StageHandlerRegistry } from '../handlers/index.js';
import type { StageDefinition } from '../types.js';

for (const stages of [undefined, []] satisfies Array<
  StageDefinition[] | undefined
>) {
  test(`unlimited repeat with ${stages ? 'empty' : 'missing'} children completes`, async () => {
    const pipeline = new DefaultPipeline({
      stepperCoordinator: {
        execute(ctx) {
          return new PipelineExecutor(new Map(), ctx.tracer).executeStages(
            [{ id: 'repeat', type: 'repeat', stages }],
            ctx,
            new NoopTracer().startSpan('repeat-test'),
          );
        },
      },
    });
    const { deps } = makeDefaultDeps();
    pipeline.initialize(deps);
    const result = await pipeline.execute(
      'work',
      [],
      testCallOptions(),
      () => {},
    );
    assert.equal(result.error, undefined);
  });
}

for (const maxIterations of [undefined, 3]) {
  test(`repeat stage limit: ${maxIterations ?? 'unlimited'}`, async () => {
    let rounds = 0;
    const pipeline = new DefaultPipeline({
      stepperCoordinator: {
        async execute(ctx) {
          ctx.shouldRetrieve = false;
          const handlers: StageHandlerRegistry = new Map([
            [
              'classify',
              {
                async execute() {
                  rounds++;
                  ctx.shouldRetrieve = rounds === 12;
                  return true;
                },
              },
            ],
          ]);
          return new PipelineExecutor(handlers, ctx.tracer).executeStages(
            [
              {
                id: 'repeat',
                type: 'repeat',
                maxIterations,
                until: 'shouldRetrieve',
                stages: [{ id: 'work', type: 'classify' }],
              },
            ],
            ctx,
            new NoopTracer().startSpan('repeat-test'),
          );
        },
      },
    });
    const { deps } = makeDefaultDeps();
    pipeline.initialize(deps);
    const result = await pipeline.execute(
      'work',
      [],
      testCallOptions(),
      () => {},
    );
    assert.equal(result.error, undefined);
    assert.equal(rounds, maxIterations ?? 12);
  });
}
