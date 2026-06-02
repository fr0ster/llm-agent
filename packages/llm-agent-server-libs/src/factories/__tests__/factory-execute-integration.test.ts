/**
 * Integration test: build a coordinator via CyclicFactory and invoke
 * handler.execute() with stubbed dependencies.  This test proves a
 * FACTORY-BUILT coordinator actually runs end-to-end — catching wiring
 * breaks that kind/build smoke tests cannot.
 *
 * Stub LLM contract:
 *   - chat()       → returns a final answer with no tool calls (executor finishes in 1 turn)
 *   - streamChat() → yields a single content chunk then a stop chunk (finalizer path)
 *
 * Stub knowledgeRag: IKnowledgeRagHandle with no-op / empty implementations.
 * Stub toolsRag:     IToolsRagHandle whose query() returns [] (no tools seeded).
 *
 * The handler is expected to return true and to yield at least one content
 * chunk (the finalizer's output) into the collected chunks array.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IKnowledgeRagHandle,
  ISpan,
  IToolsRagHandle,
  LlmStreamChunk,
  OrchestratorError,
  Result,
} from '@mcp-abap-adt/llm-agent';
import type { PipelineContext } from '@mcp-abap-adt/llm-agent-libs';
import { CyclicFactory } from '../cyclic-factory.js';

// ---------------------------------------------------------------------------
// Stub LLM
// ---------------------------------------------------------------------------

const stubLlm = {
  name: 'stub',
  model: 'stub',
  async chat() {
    return {
      ok: true as const,
      value: {
        content: 'The answer is 42.',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        toolCalls: [],
      },
    };
  },
  async *streamChat() {
    yield {
      ok: true as const,
      value: {
        content: 'Final answer from stub.',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      } satisfies LlmStreamChunk,
    };
    yield {
      ok: true as const,
      value: {
        content: '',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      } satisfies LlmStreamChunk,
    };
  },
};

// ---------------------------------------------------------------------------
// Stub KnowledgeRag (IKnowledgeRagHandle)
// ---------------------------------------------------------------------------

const stubKnowledgeRag: IKnowledgeRagHandle = {
  async query() {
    return [];
  },
  async list() {
    return [];
  },
  async write() {},
  fingerprint() {
    return 'stub-fp';
  },
  async hasArtifact() {
    return false;
  },
  async getArtifact() {
    return undefined;
  },
  async listArtifacts() {
    return [];
  },
};

// ---------------------------------------------------------------------------
// Stub ToolsRag (IToolsRagHandle)
// ---------------------------------------------------------------------------

const stubToolsRag: IToolsRagHandle = {
  async query() {
    return [];
  },
  lookup() {
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Factory deps
// ---------------------------------------------------------------------------

const factoryDeps = {
  makeRoleLlm: async () => stubLlm as never,
  callMcp: async () => '',
  knowledgeRagFor: async () => stubKnowledgeRag,
  toolsRag: stubToolsRag,
  mintStepperId: (() => {
    let n = 0;
    return () => `sid-${++n}`;
  })(),
  mintTurnId: (() => {
    let n = 0;
    return () => `tid-${++n}`;
  })(),
  registry: new Map(),
};

// CyclicFactory config: planner='none' (trivialPlanner, no LLM), executor=cyclic-react.
// allowToolless is set via the executor in buildFromComposition; the trivialPlanner
// emits a single root node so the executor runs once against the stub LLM.
const factoryCfg = {
  granularity: 'shallow',
  finalizer: 'llm',
  evaluatorEnabled: false,
  evaluatorAtDepths: { has: () => false },
  reviewerAtDepths: { has: () => false },
  maxParallelSteps: 1,
  maxDepth: 2,
  tokenBudget: 100_000,
  formalizeTask: false,
} as never;

// ---------------------------------------------------------------------------
// Stub IRequestLogger
// ---------------------------------------------------------------------------

const stubRequestLogger = {
  logLlmCall() {},
  logRagQuery() {},
  logToolCall() {},
  startRequest() {},
  endRequest() {},
  dropRequest() {},
  getSummary() {
    return { byComponent: {} };
  },
  reset() {},
};

// ---------------------------------------------------------------------------
// Stub ISpan
// ---------------------------------------------------------------------------

const stubSpan: ISpan = {
  name: 'stub-span',
  setAttribute() {},
  addEvent() {},
  setStatus() {},
  end() {},
};

// ---------------------------------------------------------------------------
// Minimal PipelineContext builder
// ---------------------------------------------------------------------------

function makeCtx(): PipelineContext & {
  chunks: Result<LlmStreamChunk, OrchestratorError>[];
} {
  const chunks: Result<LlmStreamChunk, OrchestratorError>[] = [];
  return {
    // -- immutable input
    textOrMessages: 'What is the answer?',
    options: undefined,
    config: {} as never,
    sessionId: 'session-test',

    // -- dependencies (all stubbed with as never except those actually read)
    mainLlm: stubLlm as never,
    helperLlm: undefined,
    classifierLlm: stubLlm as never,
    classifier: {} as never,
    assembler: {} as never,
    ragStores: {} as never,
    ragRegistry: undefined,
    ragProviderRegistry: undefined,
    mcpClients: [],
    reranker: {} as never,
    queryExpander: {} as never,
    toolCache: {} as never,
    outputValidator: {} as never,
    sessionManager: {} as never,
    tracer: {} as never,
    metrics: {} as never,
    logger: undefined,
    requestLogger: stubRequestLogger as never,
    toolPolicy: undefined,
    injectionDetector: undefined,
    toolAvailabilityRegistry: {} as never,
    pendingToolResults: {} as never,
    skillManager: undefined,
    embedder: undefined,
    toolSelectionStrategy: undefined,
    historyMemory: undefined,
    historySummarizer: undefined,
    llmCallStrategy: {} as never,

    // -- mutable state
    inputText: 'What is the answer?',
    history: [],
    subprompts: [],
    toolClientMap: new Map(),
    ragText: '',
    queryEmbedding: undefined,
    ragResults: {},
    mcpTools: [],
    selectedTools: [],
    externalTools: [],
    assembledMessages: [],
    activeTools: [],
    selectedSkills: [],
    skillContent: '',
    skillArgs: '',

    // -- flags
    shouldRetrieve: false,
    isAscii: true,
    isSapRequired: false,

    // -- output
    timing: [],

    // -- streaming
    yield(chunk) {
      chunks.push(chunk);
    },

    // -- expose collected chunks for assertions
    chunks,
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('CyclicFactory execute() integration: handler runs end-to-end with stubs', async () => {
  const factory = new CyclicFactory();
  const built = await factory.build(factoryCfg, factoryDeps as never);

  assert.equal(
    typeof built.handler.execute,
    'function',
    'execute is a function',
  );

  const ctx = makeCtx();
  const result = await built.handler.execute(ctx, {}, stubSpan);

  // The handler should signal success.
  assert.equal(result, true, 'execute() returned true (success)');

  // At least one content chunk should have been yielded (finalizer output).
  const contentChunks = ctx.chunks.filter(
    (c) => c.ok && c.value.content && c.value.content.length > 0,
  );
  assert.ok(contentChunks.length > 0, 'at least one content chunk yielded');

  // A terminal stop chunk should have been yielded.
  const stopChunks = ctx.chunks.filter(
    (c) => c.ok && c.value.finishReason === 'stop',
  );
  assert.ok(stopChunks.length > 0, 'a terminal stop chunk was yielded');
});
