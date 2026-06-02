import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BuiltCoordinator,
  IPipelineFactory,
  PipelineFactoryDepsBase,
} from '../pipeline-factory.js';

test('IPipelineFactory: a stub factory satisfies the contract', async () => {
  const handler = {
    name: 'coordinator',
    async execute() {
      return true;
    },
  };
  const factory: IPipelineFactory<{ x: number }> = {
    kind: 'linear',
    async build() {
      return { handler } as BuiltCoordinator;
    },
  };
  const deps: PipelineFactoryDepsBase = {
    makeRoleLlm: async () =>
      ({
        name: 'stub',
        async chat() {
          return { ok: true, value: { content: '' } };
        },
      }) as never,
    callMcp: async () => '',
  };
  const built = await factory.build({ x: 1 }, deps);
  assert.equal(built.handler.name, 'coordinator');
  assert.equal(factory.kind, 'linear');
});
