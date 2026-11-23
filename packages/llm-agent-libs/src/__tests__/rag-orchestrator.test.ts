import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  IMcpClient,
  ISkill,
  ISkillManager,
  McpTool,
  RagResult,
  Result,
  SkillError,
} from '@mcp-abap-adt/llm-agent';
import {
  LlmError,
  MODEL_CONTEXT_EXCEEDED,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import { RagOrchestrator } from '../agent/rag-orchestrator.js';
import type { RagOrchestratorDeps } from '../agent/rag-orchestrator-types.js';
import { NoopRequestLogger } from '../logger/noop-request-logger.js';
import type {
  IMcpToolRegistry,
  ToolRegistryResult,
} from '../mcp/tool-registry.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import {
  makeAssembler,
  makeCapturingMetrics,
  makeClassifier,
  makeLlm,
  makeQueryExpander,
  makeRag,
  makeReranker,
  makeSessionManager,
  ownedTestStores,
  testCallOptions,
  testRequestAccess,
} from '../testing/index.js';
import { NoopTracer } from '../tracer/noop-tracer.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeToolRegistry(tools: McpTool[]): IMcpToolRegistry {
  const toolClientMap = new Map<string, IMcpClient>();
  return {
    async resolve(): Promise<ToolRegistryResult> {
      return { tools, toolClientMap };
    },
    async resolveActiveClients(): Promise<void> {},
    getActiveClients(): IMcpClient[] {
      // One dummy client so hasMcpClients is true.
      return [{} as IMcpClient];
    },
  };
}

function makeSkillManager(name: string, body: string): ISkillManager {
  const skill: ISkill = {
    name,
    description: `desc of ${name}`,
    meta: {},
    async getContent(): Promise<Result<string, SkillError>> {
      return { ok: true, value: body };
    },
    async listResources() {
      return { ok: true, value: [] };
    },
    async readResource() {
      return { ok: true, value: '' };
    },
  };
  return {
    async listSkills(): Promise<Result<ISkill[], SkillError>> {
      return { ok: true, value: [skill] };
    },
    async getSkill(): Promise<Result<ISkill | undefined, SkillError>> {
      return { ok: true, value: skill };
    },
    async matchSkills(): Promise<Result<ISkill[], SkillError>> {
      return { ok: true, value: [skill] };
    },
  };
}

const mcpTool = (name: string): McpTool => ({
  name,
  description: `Tool ${name}`,
  inputSchema: {},
});

function ragDocs(): RagResult[] {
  return [
    {
      text: 'Tool: GetProgram — read an ABAP program',
      metadata: { id: 'tool:GetProgram' },
      score: 0.9,
    },
    {
      text: 'Skill: my-skill — how to read programs',
      metadata: { id: 'skill:my-skill' },
      score: 0.8,
    },
  ];
}

function makeOrchestrator(
  mcpToolRegistry?: IMcpToolRegistry,
  documents = ragDocs(),
  overrides?: Partial<RagOrchestratorDeps>,
) {
  return new RagOrchestrator({
    ragAccess: testRequestAccess,
    mainLlm: makeLlm([]),
    helperLlm: undefined,
    classifier: makeClassifier([
      { type: 'action', text: 'read program', dependency: 'independent' },
    ]),
    config: { maxIterations: 5 },
    tracer: new NoopTracer(),
    metrics: makeCapturingMetrics(),
    reranker: makeReranker(),
    queryExpander: makeQueryExpander(),
    sessionManager: makeSessionManager(),
    toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
    mcpToolRegistry:
      mcpToolRegistry ??
      makeToolRegistry([mcpTool('GetProgram'), mcpTool('GetInclude')]),
    requestLogger: new NoopRequestLogger(),
    ragStores: ownedTestStores({ kb: makeRag(documents) }),
    embedder: undefined,
    assembler: makeAssembler([
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'read program' },
    ]),
    skillManager: makeSkillManager('my-skill', 'STEP 1: call GetProgram'),
    translateQueryStores: undefined,
    ...overrides,
  });
}

const opts: { opts: CallOptions | undefined } = { opts: undefined };

for (const thrown of [false, true]) {
  for (const terminal of [false, true]) {
    const error = new LlmError(
      'Expansion failed',
      terminal ? MODEL_CONTEXT_EXCEEDED : 'LLM_ERROR',
    );
    it(`orchestrator handles ${thrown ? 'thrown' : 'returned'} expansion ${error.code}`, async () => {
      let calls = 0;
      const llm = makeLlm([]);
      llm.chat = async () => {
        calls++;
        if (thrown) throw error;
        return { ok: false, error };
      };
      const queries: string[] = [];
      const rag = makeRag([]);
      const orchestrator = makeOrchestrator(undefined, [], {
        config: { maxIterations: 5, queryExpansionEnabled: true },
        translateQueryStores: new Set(['kb']),
        toEnglishForRag: async () => 'translated query',
        ragStores: ownedTestStores({
          kb: {
            ...rag,
            async query(embedding, k, options) {
              queries.push(embedding.text);
              return rag.query(embedding, k, options);
            },
          },
        }),
        queryExpander: {
          async expand(query) {
            const result = await llm.chat([{ role: 'user', content: query }]);
            if (result.ok) return { ok: true, value: result.value.content };
            return {
              ok: false,
              error: Object.assign(new RagError(error.message), {
                cause: result.error,
              }),
            };
          },
        },
      });
      const pending = orchestrator.orchestrate('read program', {
        opts: testCallOptions(undefined),
        rootSpan: new NoopTracer().startSpan('root'),
        sessionId: 'expansion-error',
        mode: 'hard',
        externalTools: [],
      });
      if (terminal) {
        const result = await pending;
        assert.ok(!result.ok);
        assert.equal(result.error.code, MODEL_CONTEXT_EXCEEDED);
      } else if (thrown) {
        await assert.rejects(pending, (failure) => failure === error);
      } else {
        assert.ok((await pending).ok);
      }
      assert.deepEqual(
        queries,
        terminal || thrown ? [] : ['translated query', 'translated query'],
      );
      assert.equal(calls, 1);
    });
  }
}

describe('RagOrchestrator.orchestrate()', () => {
  it('hard mode loads no skills without a semantic match', async () => {
    const result = await makeOrchestrator(undefined, []).orchestrate('q', {
      opts: testCallOptions(undefined),
      rootSpan: new NoopTracer().startSpan('root'),
      sessionId: 'no-match',
      mode: 'hard',
      externalTools: [],
    });
    assert.ok(result.ok);
    assert.equal(result.value.skillContent, '');
    assert.ok(
      result.value.assembledMessages.every(
        (message) => !message.content?.includes('STEP 1: call GetProgram'),
      ),
    );
  });
  it('reports availability from the selection snapshot when the catalogue grows', async () => {
    const tools = ['GetProgram', 'Two', 'Three', 'Four', 'Five'].map(mcpTool);
    let resolves = 0;
    const registry = makeToolRegistry(tools);
    registry.resolve = async () => ({
      tools: ++resolves === 1 ? tools.slice(0, 3) : tools,
      toolClientMap: new Map<string, IMcpClient>(),
    });
    const result = await makeOrchestrator(registry).orchestrate(
      'read program',
      {
        opts: testCallOptions(undefined),
        rootSpan: new NoopTracer().startSpan('root'),
        sessionId: 'changing-catalogue',
        mode: 'hard',
        externalTools: [mcpTool('External')],
      },
    );

    assert.ok(result.ok);
    assert.equal(resolves, 2);
    assert.equal(result.value.toolsAvailable, 6);
    assert.ok(result.value.finalTools.length <= result.value.toolsAvailable);
  });

  it('selects RAG-matched tools, injects the matched skill, and assembles context', async () => {
    const orch = makeOrchestrator();
    const rootSpan = new NoopTracer().startSpan('root', { traceId: 't' });

    const result = await orch.orchestrate('read program', {
      opts: testCallOptions(opts.opts),
      rootSpan,
      sessionId: 'default',
      mode: 'hard',
      externalTools: [],
    });

    assert.ok(result.ok, 'orchestrate should succeed');
    const { retrieved, finalTools, skillContent, assembledMessages } =
      result.value;

    // RAG-matched MCP tool is selected (GetInclude is filtered out).
    assert.deepEqual(
      retrieved.tools.map((t) => t.name),
      ['GetProgram'],
    );
    assert.deepEqual(
      finalTools.map((t) => t.name),
      ['GetProgram'],
    );

    // The matched skill content is collected.
    assert.match(skillContent, /my-skill/);
    assert.match(skillContent, /STEP 1: call GetProgram/);

    // Skill content is injected into the assembled system message.
    const sys = assembledMessages.find((m) => m.role === 'system');
    assert.ok(sys, 'system message present');
    assert.match(sys.content as string, /## Active Skills/);
    assert.match(sys.content as string, /STEP 1: call GetProgram/);
  });
});

for (const fallback of [false, true]) {
  for (const ordinaryRejects of [false, true]) {
    for (const overflowRejects of [false, true]) {
      it(`orchestrator prioritizes ${overflowRejects ? 'rejected' : 'returned'} overflow over an ordinary ${ordinaryRejects ? 'rejection' : 'result'} in ${fallback ? 'skill fallback' : 'initial retrieval'}`, async () => {
        const ordinary = new RagError('Store unavailable', 'QUERY_ERROR');
        const overflow = new RagError(
          'Prompt too long',
          MODEL_CONTEXT_EXCEEDED,
        );
        const first = makeRag([]);
        const second = makeRag([]);
        let firstCalls = 0;
        let secondCalls = 0;
        first.query = async () => {
          if (++firstCalls === 1 && fallback) return { ok: true, value: [] };
          if (ordinaryRejects) throw ordinary;
          return { ok: false, error: ordinary };
        };
        second.query = async () => {
          if (++secondCalls === 1 && fallback) return { ok: true, value: [] };
          if (overflowRejects)
            throw new Error('Vector search failed', { cause: overflow });
          return { ok: false, error: overflow };
        };
        const orchestrator = makeOrchestrator(undefined, [], {
          ragStores: ownedTestStores({ first, second }),
        });
        const result = await orchestrator.orchestrate('read program', {
          opts: testCallOptions(),
          rootSpan: new NoopTracer().startSpan('test'),
          sessionId: 'retrieve',
          mode: 'hard',
          externalTools: [],
        });
        assert.deepEqual(result, { ok: false, error: overflow });
      });
    }
  }
}

it('orchestrator still rejects with the first ordinary rejection in settlement order', async () => {
  const first = makeRag([]);
  const second = makeRag([]);
  const ordinary = new RagError('Store unavailable', 'QUERY_ERROR');
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  first.query = async () => {
    await gate;
    throw new Error('Slower rejection');
  };
  second.query = async () => {
    queueMicrotask(release);
    throw ordinary;
  };
  const orchestrator = makeOrchestrator(undefined, [], {
    ragStores: ownedTestStores({ first, second }),
  });
  await assert.rejects(
    orchestrator.orchestrate('read program', {
      opts: testCallOptions(),
      rootSpan: new NoopTracer().startSpan('test'),
      sessionId: 'retrieve',
      mode: 'hard',
      externalTools: [],
    }),
    (error) => error === ordinary,
  );
});

it('orchestrator prioritizes returned reranker overflow over a sibling rejection', async () => {
  const overflow = new RagError('Prompt too long', MODEL_CONTEXT_EXCEEDED);
  const ragStores = ownedTestStores({
    first: makeRag([{ text: 'ordinary failure', metadata: {}, score: 1 }]),
    second: makeRag([{ text: 'overflow', metadata: {}, score: 1 }]),
  });
  const orchestrator = makeOrchestrator(undefined, [], {
    ragStores,
    reranker: {
      async rerank(_query, results) {
        if (results[0].text === 'ordinary failure')
          throw new Error('Reranker unavailable');
        return { ok: false, error: overflow };
      },
    },
  });
  const result = await orchestrator.orchestrate('read program', {
    opts: testCallOptions(),
    rootSpan: new NoopTracer().startSpan('test'),
    sessionId: 'rerank',
    mode: 'hard',
    externalTools: [],
  });
  assert.deepEqual(result, { ok: false, error: overflow });
});

for (const operation of ['list', 'content']) {
  it(`orchestrator propagates context overflow from skill ${operation}`, async () => {
    const overflow = new RagError('Prompt too long', MODEL_CONTEXT_EXCEEDED);
    const skillManager = makeSkillManager('my-skill', 'content');
    const originalList = skillManager.listSkills.bind(skillManager);
    skillManager.listSkills = async () => {
      if (operation === 'list') return { ok: false, error: overflow };
      const listed = await originalList();
      assert.ok(listed.ok);
      listed.value[0].getContent = async () => ({ ok: false, error: overflow });
      return listed;
    };
    const result = await makeOrchestrator(undefined, ragDocs(), {
      skillManager,
    }).orchestrate('read program', {
      opts: testCallOptions(),
      rootSpan: new NoopTracer().startSpan('test'),
      sessionId: 'skills',
      mode: 'hard',
      externalTools: [],
    });
    assert.deepEqual(result, { ok: false, error: overflow });
  });
}
