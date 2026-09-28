import type { IEmbedder, ILlm, ISubAgent } from '@mcp-abap-adt/llm-agent';
import {
  InMemoryKnowledgeBackend,
  SmartAgentBuilder,
} from '@mcp-abap-adt/llm-agent-libs';
import { makeKnowledgeSemanticIndex } from '../../smart-agent/embedder-knowledge-index.js';
import type {
  IControllerServerPipelineContext,
  IServerPipelineContext,
} from '../server-context.js';

const stubLlm: ILlm = {
  chat: async () =>
    ({ ok: true, value: { content: 'ok', toolCalls: [] } }) as never,
  streamChat: async function* () {},
  model: 'stub',
} as unknown as ILlm;

// Minimal worker so buildDagCoordinatorDeps doesn't throw on empty workers
// (build-dag-coordinator-deps.ts). Harmless for flat/linear/stepper.
const stubWorker: ISubAgent = {
  name: 'worker',
  run: async () => ({ ok: true, value: { content: '' } }) as never,
} as unknown as ISubAgent;

export function fakeServerCtx(): IServerPipelineContext {
  return {
    resolveLlm: async () => stubLlm,
    resolveNamedLlm: async () => stubLlm,
    knowledgeRagFor: () =>
      ({ add: async () => {}, query: async () => [] }) as never,
    toolsRag: { query: async () => [], lookup: () => undefined },
    callMcp: async () => '',
    subagents: [{ name: 'worker', description: 'stub' }],
    mintStepperId: () => 's1',
    mintTurnId: () => 't1',
    createAgentBuilder: async () =>
      new SmartAgentBuilder({}).withMainLlm(stubLlm).withMode('smart'),
    mainLlm: stubLlm,
    mainTemp: 0,
    workerRegistry: new Map([['worker', stubWorker]]),
    warn: () => {},
    stepperKnowledgeBackend: new InMemoryKnowledgeBackend(),
  };
}

const stubEmbedder: IEmbedder = {
  embed: async () => ({ vector: [0] }),
  dimensions: 1,
} as unknown as IEmbedder;

/** Controller-flavored ctx: extends fakeServerCtx with the fields the
 *  ControllerCoordinatorHandler needs (backend, embedder). External tools are
 *  routed per-request via PipelineContext.externalTools, not this ctx. The backend
 *  carries an embedder-backed semantic index so it is semanticRecallCapable (the
 *  controller factory requires it — production wires this via buildKnowledgeBackend). */
export function fakeControllerServerCtx(): IControllerServerPipelineContext {
  return {
    ...fakeServerCtx(),
    stepperKnowledgeBackend: new InMemoryKnowledgeBackend(
      makeKnowledgeSemanticIndex(symmetricEmbedder(stubEmbedder)),
    ),
    embedder: symmetricEmbedder(stubEmbedder),
  };
}

import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import type { PlannerKind } from '../../smart-agent/controller/types.js';
import { parseControllerSettings } from '../../smart-agent/pipeline-settings.js';
import { ControllerPipelinePlugin } from '../controller.js';

/** The smallest valid controller section: every role takes its own name's default. */
export const MIN_CONTROLLER_SECTION = {
  subagents: { evaluator: {}, planner: {}, executor: {} },
};

/** A controller plugin constructed the way SmartServer's registry constructs it,
 *  with the keys of the `llm:` map the section may name. */
export function controllerPlugin(
  name = 'controller',
  kind: PlannerKind = 'smart-executor',
  section: unknown = MIN_CONTROLLER_SECTION,
  llmKeys: ReadonlySet<string> = new Set(['main']),
): ControllerPipelinePlugin {
  return new ControllerPipelinePlugin(
    name,
    kind,
    parseControllerSettings(section, llmKeys),
  );
}
