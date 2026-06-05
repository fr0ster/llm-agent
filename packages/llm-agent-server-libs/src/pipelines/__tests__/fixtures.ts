import type { ILlm, ISubAgent } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import type { IServerPipelineContext } from '../server-context.js';

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
    knowledgeRagFor: () =>
      ({ add: async () => {}, query: async () => [] }) as never,
    toolsRag: { query: async () => [], lookup: () => undefined },
    callMcp: async () => '',
    subagents: [{ name: 'worker', description: 'stub' }],
    mintStepperId: () => 's1',
    mintTurnId: () => 't1',
    createAgentBuilder: async () =>
      new SmartAgentBuilder({}).withMainLlm(stubLlm).withMode('smart'),
    makeLlm: async () => stubLlm,
    mainLlm: stubLlm,
    mainTemp: 0,
    workerRegistry: new Map([['worker', stubWorker]]),
    warn: () => {},
  };
}
