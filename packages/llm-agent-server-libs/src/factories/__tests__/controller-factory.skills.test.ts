import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IEmbedder,
  IKnowledgeRagHandle,
  ILlm,
} from '@mcp-abap-adt/llm-agent';
import type { ControllerHandlerDeps } from '../../smart-agent/controller/controller-coordinator-handler.js';
import { ControllerCoordinatorHandler } from '../../smart-agent/controller/controller-coordinator-handler.js';
import { makePlanner } from '../../smart-agent/controller/planner.js';
import type { ISubagentClient } from '../../smart-agent/controller/subagent-client.js';
import type {
  ControllerConfig,
  SessionBundle,
} from '../../smart-agent/controller/types.js';
import {
  ControllerFactory,
  type ControllerFactoryDeps,
} from '../controller-factory.js';

const llm = (model: string): ILlm =>
  ({
    model,
    chat: async () => ({ ok: true, value: { content: '' } }),
  }) as unknown as ILlm;
const embedder = {
  embed: async () => ({ vector: [1, 0, 0] }),
} as unknown as IEmbedder;
const rag: IKnowledgeRagHandle = {
  query: async () => [],
  list: async () => [],
  write: async () => {},
  fingerprint: () => 'stub',
};
const config: ControllerConfig = {
  subagents: {
    evaluator: { provider: 'x', model: 'm-eval' },
    planner: { provider: 'x', model: 'm-plan' },
    executor: { provider: 'x', model: 'm-exec' },
  } as never,
  planner: 'adaptive',
  targetState: { strategy: 'consumer-confirm', distanceThreshold: 0.5 },
  sessionMemory: { collection: 'c' },
  budgets: { maxSteps: 5, maxRetries: 2, maxRewinds: 2 },
};
const baseDeps = (): Omit<ControllerFactoryDeps, 'embedder' | 'backend'> => ({
  makeRoleLlm: async (role) => llm(`m-${role}`),
  callMcp: async () => 'out',
  knowledgeRagFor: () => rag,
  selectTools: async () => [],
});

test('factory threads skillsRecall into the handler deps; the planner invokes it', async () => {
  let calls = 0;
  const spy = async (goal: string): Promise<string> => {
    calls++;
    assert.equal(goal, 'the goal');
    return 'Relevant skills:\n- spy';
  };

  const { handler } = await new ControllerFactory().build(config, {
    ...baseDeps(),
    backend: { semanticRecallCapable: true } as never,
    embedder,
    skillsRecall: spy,
  });

  // The factory must pass skillsRecall through to the handler deps.
  const deps = (handler as unknown as { deps: ControllerHandlerDeps }).deps;
  assert.equal(typeof deps.skillsRecall, 'function');

  // And the planner the handler builds invokes it during create-plan: drive the
  // same construction path the handler uses (makePlanner with deps.skillsRecall).
  let userMsg = '';
  const recording: ISubagentClient = {
    async send(messages) {
      userMsg =
        typeof messages[1]?.content === 'string' ? messages[1].content : '';
      return {
        kind: 'content',
        content: JSON.stringify({ plan: [{ name: 's1', instructions: 'do' }] }),
      };
    },
  };
  const planner = makePlanner(
    'adaptive',
    recording,
    undefined,
    deps.skillsRecall,
  );
  const bundle: SessionBundle = {
    goal: 'the goal',
    plannerPrivate: '',
    budgets: { stepsUsed: 0, rewindsUsed: 0 },
  };
  await planner.next({ bundle, prompt: 'r', retrying: false });

  assert.equal(
    calls,
    1,
    'planner invoked skillsRecall once during create-plan',
  );
  assert.match(userMsg, /Relevant skills:\n- spy/);
});

test('factory omits skillsRecall from handler deps when not supplied', async () => {
  const { handler } = await new ControllerFactory().build(config, {
    ...baseDeps(),
    backend: { semanticRecallCapable: true } as never,
    embedder,
  });
  const deps = (handler as unknown as { deps: ControllerHandlerDeps }).deps;
  assert.equal(deps.skillsRecall, undefined);
  assert.ok(handler instanceof ControllerCoordinatorHandler);
});
