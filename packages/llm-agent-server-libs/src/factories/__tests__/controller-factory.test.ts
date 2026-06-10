import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IEmbedder,
  IKnowledgeRagHandle,
  ILlm,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryKnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import { ControllerCoordinatorHandler } from '../../smart-agent/controller/controller-coordinator-handler.js';
import type { ControllerConfig } from '../../smart-agent/controller/types.js';
import {
  ControllerFactory,
  type ControllerFactoryDeps,
} from '../controller-factory.js';

const llm = {
  model: 'm-x',
  chat: async () => ({ ok: true, value: { content: '' } }),
} as unknown as ILlm;
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
  subagents: {} as never,
  targetState: { strategy: 'semantic-distance', distanceThreshold: 0.9 },
  sessionMemory: { collection: 'c' },
  budgets: { maxSteps: 5, maxRetries: 2, maxRewinds: 2 },
};
const baseDeps = (): Omit<ControllerFactoryDeps, 'embedder'> => ({
  makeRoleLlm: async () => llm,
  callMcp: async () => 'out',
  backend: new InMemoryKnowledgeBackend(),
  knowledgeRagFor: () => rag,
  selectTools: async () => [],
});

test('ControllerFactory.build returns a ControllerCoordinatorHandler', async () => {
  const factory = new ControllerFactory();
  assert.equal(factory.kind, 'controller');
  const { handler } = await factory.build(config, { ...baseDeps(), embedder });
  assert.ok(handler instanceof ControllerCoordinatorHandler);
  assert.equal(typeof (handler as { execute?: unknown }).execute, 'function');
});

test('ControllerFactory.build throws for a distance strategy with no embedder', async () => {
  await assert.rejects(
    () => new ControllerFactory().build(config, baseDeps()),
    /requires an .*embedder/,
  );
});
