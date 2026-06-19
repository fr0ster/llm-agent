import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IEmbedder,
  IKnowledgeRagHandle,
  ILlm,
} from '@mcp-abap-adt/llm-agent';
import { ControllerCoordinatorHandler } from '../../smart-agent/controller/controller-coordinator-handler.js';
import type { ControllerConfig } from '../../smart-agent/controller/types.js';
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
// 3-role config (no reviewer/finalizer subagent → both default to the planner LLM).
const config: ControllerConfig = {
  subagents: {
    evaluator: { provider: 'x', model: 'm-eval' },
    planner: { provider: 'x', model: 'm-plan' },
    executor: { provider: 'x', model: 'm-exec' },
  } as never,
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

test('builds a handler with reviewer+finalizer (semantic-capable backend + embedder)', async () => {
  const factory = new ControllerFactory();
  assert.equal(factory.kind, 'controller');
  const { handler } = await factory.build(config, {
    ...baseDeps(),
    backend: { semanticRecallCapable: true } as never,
    embedder,
  });
  assert.ok(handler instanceof ControllerCoordinatorHandler);
  assert.equal(typeof (handler as { execute?: unknown }).execute, 'function');
});

test('throws when no embedder is provided (recall is embedding-based, any persistence mode)', async () => {
  await assert.rejects(
    () =>
      new ControllerFactory().build(config, {
        ...baseDeps(),
        backend: { semanticRecallCapable: true } as never,
        // no embedder
      } as ControllerFactoryDeps),
    /embedder/,
  );
});

test('throws when an embedder is present but the backend is NOT semantic-recall-capable', async () => {
  await assert.rejects(
    () =>
      new ControllerFactory().build(config, {
        ...baseDeps(),
        backend: { semanticRecallCapable: false } as never,
        embedder,
      }),
    /semantic-recall-capable/,
  );
});

const semanticCapableDeps = (): ControllerFactoryDeps => ({
  ...baseDeps(),
  backend: { semanticRecallCapable: true } as never,
  embedder,
});

test('ControllerFactory.build rejects a board budget that cannot fit', async () => {
  const badBudgetConfig: ControllerConfig = {
    ...config,
    budgets: {
      ...config.budgets,
      maxBoardChars: 50, // far too small for the default actionable worst-case
      maxActiveSteps: 16,
      maxIntentChars: 120,
      maxDigestChars: 500,
      keepRecentDigests: 8,
    },
  };
  await assert.rejects(
    () => new ControllerFactory().build(badBudgetConfig, semanticCapableDeps()),
    /maxBoardChars/,
  );
});
