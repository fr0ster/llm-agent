import { InMemoryRag, type RagResult } from '@mcp-abap-adt/llm-agent';
import { testRagAccess } from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';
import { RagOrchestrator } from '../../agent/rag-orchestrator.js';
import { NoopRequestLogger } from '../../logger/noop-request-logger.js';
import { ToolAvailabilityRegistry } from '../../policy/tool-availability-registry.js';
import {
  makeAssembler,
  makeCapturingMetrics,
  makeClassifier,
  makeLlm,
  makeQueryExpander,
  makeReranker,
  makeSessionManager,
} from '../../testing/index.js';
import { NoopTracer } from '../../tracer/noop-tracer.js';
import type { OwnedRagStore } from '../owner-bound-query.js';

export const callerA = { sessionId: 'A', userId: 'alice', isAdmin: false };

export async function sharedStore(): Promise<OwnedRagStore> {
  const rag = new InMemoryRag();
  for (const sessionId of ['A', 'B']) {
    const result = await rag
      .writer()
      .upsertRaw(sessionId, `record ${sessionId}`, { sessionId });
    if (!result.ok) throw result.error;
  }
  return { name: 'history', owner: { scope: 'session', sessionId: 'A' }, rag };
}

export function orchestrator(store: OwnedRagStore, access = testRagAccess()) {
  return new RagOrchestrator({
    mainLlm: makeLlm([]),
    helperLlm: undefined,
    classifier: makeClassifier([{ type: 'action', text: 'record' }]),
    config: { maxIterations: 1 },
    tracer: new NoopTracer(),
    metrics: makeCapturingMetrics(),
    reranker: makeReranker(),
    queryExpander: makeQueryExpander(),
    sessionManager: makeSessionManager(),
    toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
    mcpToolRegistry: {
      resolve: async () => ({ tools: [], toolClientMap: new Map() }),
      resolveActiveClients: async () => {},
      getActiveClients: () => [],
    },
    requestLogger: new NoopRequestLogger(),
    ragStores: { history: store },
    ragAccess: access,
    embedder: undefined,
    assembler: makeAssembler(),
    skillManager: undefined,
    translateQueryStores: undefined,
  });
}

export function sessionTags(results: RagResult[]) {
  return results.map((r) => r.metadata.sessionId);
}
