import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IKnowledgeRagHandle } from '@mcp-abap-adt/llm-agent';
import { InMemoryKnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import { ControllerCoordinatorHandler } from '../../smart-agent/controller/controller-coordinator-handler.js';
import type { ISubagentClient } from '../../smart-agent/controller/subagent-client.js';
import type { ControllerConfig } from '../../smart-agent/controller/types.js';
import {
  ControllerFactory,
  type ControllerFactoryDeps,
} from '../controller-factory.js';

const stubClient: ISubagentClient = {
  async send() {
    return { kind: 'content', content: '' };
  },
};
const rag: IKnowledgeRagHandle = {
  query: async () => [],
  list: async () => [],
  write: async () => {},
  fingerprint: () => 'stub',
};
const config: ControllerConfig = {
  subagents: {} as never,
  targetState: { strategy: 'semantic-distance', distanceThreshold: 0.9 },
  sessionMemory: { collection: 'c' },
  budgets: { maxSteps: 5, maxRetries: 2, maxRewinds: 2 },
};
const deps: ControllerFactoryDeps = {
  evaluator: stubClient,
  planner: stubClient,
  executor: stubClient,
  backend: new InMemoryKnowledgeBackend(),
  knowledgeRagFor: () => rag,
  callMcp: async () => 'out',
  selectTools: async () => [],
  models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
};

test('ControllerFactory.build returns a ControllerCoordinatorHandler', async () => {
  const factory = new ControllerFactory();
  assert.equal(factory.kind, 'controller');
  const { handler } = await factory.build(config, deps);
  assert.ok(handler instanceof ControllerCoordinatorHandler);
  // The factory folds the `config` argument into the handler deps (the dep type
  // omits it), so a code-level composer passes config once.
  assert.equal(typeof (handler as { execute?: unknown }).execute, 'function');
});
