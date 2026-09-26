import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm, ISubAgent } from '@mcp-abap-adt/llm-agent';
import {
  LlmFinalizer,
  PassthroughFinalizer,
  SubAgentStateOracle,
  TemplateFinalizer,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  type BuildDagCoordinatorDepsInput,
  buildDagCoordinatorDeps,
} from '../build-dag-coordinator-deps.js';

const stubLlm = {
  name: 'stub',
  async chat() {
    return {
      ok: true as const,
      value: {
        content: '',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    };
  },
} as unknown as ILlm;

function agent(name: string): ISubAgent {
  return {
    name,
    description: 'd',
    capabilities: { contextPolicy: 'optional' },
    async run() {
      return { output: 'W' };
    },
  };
}

/** Records every lookup as `role:<name>` or `key:<name>`, so a test states which
 *  of the two questions answered each role. */
function input(
  coordCfg: Record<string, unknown> | undefined,
  over: Partial<BuildDagCoordinatorDepsInput> = {},
): BuildDagCoordinatorDepsInput & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    coordCfg,
    registry: new Map([['w', agent('w')]]),
    resolveLlm: async (role) => {
      asked.push(`role:${role}`);
      return stubLlm;
    },
    resolveNamedLlm: async (key) => {
      asked.push(`key:${key}`);
      return stubLlm;
    },
    warn: () => {},
    ...over,
  };
}

test('default finalizer is PassthroughFinalizer', async () => {
  const deps = await buildDagCoordinatorDeps(
    input({ planner: { type: 'llm' } }),
  );
  assert.ok(deps?.finalizer instanceof PassthroughFinalizer);
  assert.equal(deps?.stateOracle, undefined);
  assert.equal(deps?.reviewer, undefined);
  assert.equal(deps?.workers.size, 1);
});

test('type=llm finalizer yields LlmFinalizer', async () => {
  const deps = await buildDagCoordinatorDeps(
    input({ planner: { type: 'llm' }, finalizer: { type: 'llm' } }),
  );
  assert.ok(deps?.finalizer instanceof LlmFinalizer);
});

test('type=template finalizer yields TemplateFinalizer', async () => {
  const deps = await buildDagCoordinatorDeps(
    input({ planner: { type: 'llm' }, finalizer: { type: 'template' } }),
  );
  assert.ok(deps?.finalizer instanceof TemplateFinalizer);
});

test('stateOracle resolves, is wrapped, and leaves the worker set', async () => {
  const deps = await buildDagCoordinatorDeps(
    input(
      { planner: { type: 'llm' }, stateOracle: 'inspector' },
      {
        registry: new Map([
          ['w', agent('w')],
          ['inspector', agent('inspector')],
        ]),
      },
    ),
  );
  assert.ok(deps?.stateOracle instanceof SubAgentStateOracle);
  assert.equal(deps?.workers.has('inspector'), false);
  assert.equal(deps?.workers.has('w'), true);
});

test('returns undefined when the planner block is absent', async () => {
  assert.equal(
    await buildDagCoordinatorDeps(input({ stateOracle: 'inspector' })),
    undefined,
  );
});

test('reviewer alias plannerLlm still warns', async () => {
  const warnings: string[] = [];
  await buildDagCoordinatorDeps(
    input(
      {
        planner: { type: 'llm' },
        reviewer: { type: 'llm', plannerLlm: 'main' },
      },
      { warn: (m) => warnings.push(m) },
    ),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plannerLlm.*deprecated/i);
});

test('an omitted key asks resolveLlm with the role name', async () => {
  const i = input({
    planner: { type: 'llm' },
    reviewer: { type: 'llm' },
    finalizer: { type: 'llm' },
  });
  await buildDagCoordinatorDeps(i);
  assert.deepEqual(i.asked, [
    'role:planner',
    'role:reviewer',
    'role:finalizer',
  ]);
});

test('a named key asks resolveNamedLlm, and nothing else', async () => {
  const i = input({
    planner: { type: 'llm', plannerLlm: 'helper' },
    reviewer: { type: 'llm', reviewerLlm: 'planner' },
    finalizer: { type: 'llm', finalizerLlm: 'cheap' },
  });
  await buildDagCoordinatorDeps(i);
  assert.deepEqual(i.asked, ['key:helper', 'key:planner', 'key:cheap']);
});

test('a named key with no entry fails the build, naming the key', async () => {
  await assert.rejects(
    () =>
      buildDagCoordinatorDeps(
        input(
          { planner: { type: 'llm', plannerLlm: 'cheep' } },
          {
            resolveNamedLlm: async (key) => {
              throw new Error(`llm: has no entry named '${key}'`);
            },
          },
        ),
      ),
    /'cheep'/,
  );
});
