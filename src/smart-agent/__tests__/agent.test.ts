import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '../../types.js';
import { OrchestratorError, SmartAgent } from '../agent.js';
import type { IContextAssembler } from '../interfaces/assembler.js';
import type { ISubpromptClassifier } from '../interfaces/classifier.js';
import type { ILlm } from '../interfaces/llm.js';
import type { IMcpClient } from '../interfaces/mcp-client.js';
import type { IRag } from '../interfaces/rag.js';
import {
  AssemblerError,
  type CallOptions,
  ClassifierError,
  LlmError,
  type LlmFinishReason,
  type LlmResponse,
  type LlmToolCall,
  McpError,
  type McpTool,
  type McpToolResult,
  RagError,
  type RagResult,
  type Result,
  type Subprompt,
  type ToolCallRecord,
} from '../interfaces/types.js';

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeLlm(
  responses: Array<
    | {
        content: string;
        toolCalls?: LlmToolCall[];
        finishReason?: LlmFinishReason;
      }
    | Error
  >,
): ILlm & { callCount: number } {
  let callCount = 0;
  const queue = [...responses];
  return {
    get callCount() {
      return callCount;
    },
    async chat(
      _messages: Message[],
      _tools?: LlmToolCall[],
      _opts?: CallOptions,
    ): Promise<Result<LlmResponse, LlmError>> {
      callCount++;
      const next = queue.shift();
      if (!next) {
        return {
          ok: true,
          value: { content: 'default', finishReason: 'stop' },
        };
      }
      if (next instanceof Error) {
        return { ok: false, error: new LlmError(next.message) };
      }
      return {
        ok: true,
        value: {
          content: next.content,
          toolCalls: next.toolCalls,
          finishReason: next.finishReason ?? 'stop',
        },
      };
    },
  };
}

function makeRag(
  queryResults: RagResult[] = [],
): IRag & { upsertCalls: string[] } {
  const upsertCalls: string[] = [];
  return {
    upsertCalls,
    async upsert(
      text: string,
      _metadata: Record<string, unknown>,
      _opts?: CallOptions,
    ): Promise<Result<void, RagError>> {
      upsertCalls.push(text);
      return { ok: true, value: undefined };
    },
    async query(
      _text: string,
      _k: number,
      _opts?: CallOptions,
    ): Promise<Result<RagResult[], RagError>> {
      return { ok: true, value: queryResults };
    },
  };
}

function makeFailingRag(): IRag & { upsertCalls: string[] } {
  const upsertCalls: string[] = [];
  return {
    upsertCalls,
    async upsert(text: string): Promise<Result<void, RagError>> {
      upsertCalls.push(text);
      return { ok: false, error: new RagError('Upsert failed') };
    },
    async query(): Promise<Result<RagResult[], RagError>> {
      return { ok: false, error: new RagError('Query failed') };
    },
  };
}

function makeMcpClient(
  tools: McpTool[],
  callResults?: Map<string, McpToolResult | Error>,
): IMcpClient {
  return {
    async listTools(_opts?: CallOptions): Promise<Result<McpTool[], McpError>> {
      return { ok: true, value: tools };
    },
    async callTool(
      name: string,
      _args: Record<string, unknown>,
      _opts?: CallOptions,
    ): Promise<Result<McpToolResult, McpError>> {
      const result = callResults?.get(name);
      if (result instanceof Error) {
        return { ok: false, error: new McpError(result.message) };
      }
      if (result) {
        return { ok: true, value: result };
      }
      return { ok: true, value: { content: `result of ${name}` } };
    },
  };
}

function makeClassifier(result: Subprompt[] | Error): ISubpromptClassifier {
  return {
    async classify(
      _text: string,
      _opts?: CallOptions,
    ): Promise<Result<Subprompt[], ClassifierError>> {
      if (result instanceof Error) {
        const code =
          result.message === 'ABORTED' ? 'ABORTED' : 'CLASSIFIER_ERROR';
        return { ok: false, error: new ClassifierError(result.message, code) };
      }
      return { ok: true, value: result };
    },
  };
}

function makeAssembler(result?: Message[] | Error): IContextAssembler {
  const defaultMessages: Message[] = [{ role: 'user', content: 'action text' }];
  return {
    async assemble(
      _action: Subprompt,
      _retrieved: {
        facts: RagResult[];
        feedback: RagResult[];
        state: RagResult[];
        tools: McpTool[];
      },
      _toolResults: ToolCallRecord[],
      _opts?: CallOptions,
    ): Promise<Result<Message[], AssemblerError>> {
      const r = result ?? defaultMessages;
      if (r instanceof Error) {
        const code = r.message === 'ABORTED' ? 'ABORTED' : 'ASSEMBLER_ERROR';
        return { ok: false, error: new AssemblerError(r.message, code) };
      }
      return { ok: true, value: r };
    },
  };
}

// Convenience factory: creates fully wired deps with sensible defaults.
function makeDefaultDeps(overrides?: {
  llmResponses?: Array<
    | {
        content: string;
        toolCalls?: LlmToolCall[];
        finishReason?: LlmFinishReason;
      }
    | Error
  >;
  classifier?: ISubpromptClassifier;
  assembler?: IContextAssembler;
  mcpClients?: IMcpClient[];
  ragStores?: { facts?: IRag; feedback?: IRag; state?: IRag };
}): {
  llm: ILlm & { callCount: number };
  deps: ConstructorParameters<typeof SmartAgent>[0];
} {
  const llm = makeLlm(
    overrides?.llmResponses ?? [{ content: 'hello', finishReason: 'stop' }],
  );
  return {
    llm,
    deps: {
      mainLlm: llm,
      mcpClients: overrides?.mcpClients ?? [],
      ragStores: {
        facts: overrides?.ragStores?.facts ?? makeRag(),
        feedback: overrides?.ragStores?.feedback ?? makeRag(),
        state: overrides?.ragStores?.state ?? makeRag(),
      },
      classifier:
        overrides?.classifier ??
        makeClassifier([{ type: 'action', text: 'do something' }]),
      assembler: overrides?.assembler ?? makeAssembler(),
    },
  };
}

const DEFAULT_CONFIG = { maxIterations: 5 };

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('SmartAgent — happy path: no tools → stop', () => {
  it('single LLM call, content returned, stopReason=stop', async () => {
    const { deps } = makeDefaultDeps({
      llmResponses: [{ content: 'Hello world', finishReason: 'stop' }],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('do something');
    assert.ok(r.ok);
    assert.equal(r.value.content, 'Hello world');
    assert.equal(r.value.stopReason, 'stop');
    assert.equal(r.value.iterations, 1);
    assert.equal(r.value.toolCallCount, 0);
  });
});

describe('SmartAgent — happy path: fact subprompt', () => {
  it('fact upserted into ragStores.facts', async () => {
    const facts = makeRag();
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([{ type: 'fact', text: 'The sky is blue' }]),
      ragStores: { facts },
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('The sky is blue');
    assert.ok(r.ok);
    assert.ok(facts.upsertCalls.includes('The sky is blue'));
    assert.equal(r.value.content, '');
    assert.equal(r.value.stopReason, 'stop');
  });
});

describe('SmartAgent — happy path: fact + action', () => {
  it('fact upserted + action processed independently', async () => {
    const facts = makeRag();
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([
        { type: 'fact', text: 'Important fact' },
        { type: 'action', text: 'What is 2+2?' },
      ]),
      llmResponses: [{ content: '4', finishReason: 'stop' }],
      ragStores: { facts },
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('Important fact. What is 2+2?');
    assert.ok(r.ok);
    assert.ok(facts.upsertCalls.includes('Important fact'));
    assert.equal(r.value.content, '4');
  });
});

// ---------------------------------------------------------------------------
// Tool loop
// ---------------------------------------------------------------------------

describe('SmartAgent — tool loop: one tool call', () => {
  it('LLM→tool_calls→execute→LLM→stop; toolCallCount=1', async () => {
    const client = makeMcpClient(
      [{ name: 'search', description: 'Search tool', inputSchema: {} }],
      new Map([['search', { content: 'search result' }]]),
    );
    const { deps } = makeDefaultDeps({
      mcpClients: [client],
      llmResponses: [
        {
          content: 'searching...',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'search', arguments: { q: 'test' } }],
        },
        { content: 'final answer', finishReason: 'stop' },
      ],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('search for something');
    assert.ok(r.ok);
    assert.equal(r.value.toolCallCount, 1);
    assert.equal(r.value.content, 'final answer');
    assert.equal(r.value.stopReason, 'stop');
  });
});

describe('SmartAgent — tool loop: two iterations', () => {
  it('two cycles tool call → final stop; iterations=3', async () => {
    const client = makeMcpClient(
      [{ name: 'tool1', description: 'Tool 1', inputSchema: {} }],
      new Map([['tool1', { content: 'tool1 result' }]]),
    );
    const { deps } = makeDefaultDeps({
      mcpClients: [client],
      llmResponses: [
        {
          content: 'first call',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'tool1', arguments: {} }],
        },
        {
          content: 'second call',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c2', name: 'tool1', arguments: {} }],
        },
        { content: 'done', finishReason: 'stop' },
      ],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('do two tool calls');
    assert.ok(r.ok);
    assert.equal(r.value.iterations, 3);
    assert.equal(r.value.toolCallCount, 2);
    assert.equal(r.value.stopReason, 'stop');
  });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe('SmartAgent — limits: maxIterations', () => {
  it('LLM always returns tool_calls → stop after maxIterations; stopReason=iteration_limit', async () => {
    const client = makeMcpClient([
      { name: 'tool', description: 'Tool', inputSchema: {} },
    ]);
    const loopLlm: ILlm = {
      async chat(): Promise<Result<LlmResponse, LlmError>> {
        return {
          ok: true,
          value: {
            content: 'looping',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'c1', name: 'tool', arguments: {} }],
          },
        };
      },
    };
    const { deps } = makeDefaultDeps({ mcpClients: [client] });
    deps.mainLlm = loopLlm;
    const agent = new SmartAgent(deps, { maxIterations: 3 });
    const r = await agent.process('loop forever');
    assert.ok(r.ok);
    assert.equal(r.value.stopReason, 'iteration_limit');
    assert.equal(r.value.iterations, 3);
  });
});

describe('SmartAgent — limits: maxIterations=1', () => {
  it('first response with tool_call → iteration_limit immediately', async () => {
    const client = makeMcpClient([
      { name: 'tool', description: 'Tool', inputSchema: {} },
    ]);
    const { deps } = makeDefaultDeps({
      mcpClients: [client],
      llmResponses: [
        {
          content: 'calling tool',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'tool', arguments: {} }],
        },
      ],
    });
    const agent = new SmartAgent(deps, { maxIterations: 1 });
    const r = await agent.process('test');
    assert.ok(r.ok);
    assert.equal(r.value.stopReason, 'iteration_limit');
    assert.equal(r.value.iterations, 1);
  });
});

describe('SmartAgent — limits: maxToolCalls', () => {
  it('stops after maxToolCalls; stopReason=tool_call_limit', async () => {
    const client = makeMcpClient([
      { name: 'toolA', description: 'A', inputSchema: {} },
      { name: 'toolB', description: 'B', inputSchema: {} },
      { name: 'toolC', description: 'C', inputSchema: {} },
    ]);
    const { deps } = makeDefaultDeps({
      mcpClients: [client],
      llmResponses: [
        {
          content: 'calling tools',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'c1', name: 'toolA', arguments: {} },
            { id: 'c2', name: 'toolB', arguments: {} },
            { id: 'c3', name: 'toolC', arguments: {} },
          ],
        },
      ],
    });
    const agent = new SmartAgent(deps, { maxIterations: 5, maxToolCalls: 2 });
    const r = await agent.process('test');
    assert.ok(r.ok);
    assert.equal(r.value.stopReason, 'tool_call_limit');
    assert.equal(r.value.toolCallCount, 2);
  });
});

// ---------------------------------------------------------------------------
// Classifier errors
// ---------------------------------------------------------------------------

describe('SmartAgent — classifier error', () => {
  it('returns OrchestratorError with code=CLASSIFIER_ERROR', async () => {
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier(new Error('classify failed')),
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('test');
    assert.ok(!r.ok);
    assert.ok(r.error instanceof OrchestratorError);
    assert.equal(r.error.code, 'CLASSIFIER_ERROR');
  });
});

describe('SmartAgent — classifier ABORTED', () => {
  it('returns OrchestratorError with code=ABORTED', async () => {
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier(new Error('ABORTED')),
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('test');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
  });
});

// ---------------------------------------------------------------------------
// LLM error
// ---------------------------------------------------------------------------

describe('SmartAgent — mainLlm error', () => {
  it('returns OrchestratorError with code=LLM_ERROR', async () => {
    const { deps } = makeDefaultDeps({
      llmResponses: [new Error('LLM unavailable')],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('test');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'LLM_ERROR');
    assert.ok(r.error.message.includes('LLM unavailable'));
  });
});

// ---------------------------------------------------------------------------
// Assembler error
// ---------------------------------------------------------------------------

describe('SmartAgent — assembler fails', () => {
  it('returns OrchestratorError with code=ASSEMBLER_ERROR', async () => {
    const { deps } = makeDefaultDeps({
      assembler: makeAssembler(new Error('assembler crashed')),
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('test');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ASSEMBLER_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Tool failures
// ---------------------------------------------------------------------------

describe('SmartAgent — MCP callTool error', () => {
  it('error injected as isError result; orchestrator continues', async () => {
    const client = makeMcpClient(
      [{ name: 'brokenTool', description: 'Broken', inputSchema: {} }],
      new Map([['brokenTool', new Error('tool failed')]]),
    );
    const { deps } = makeDefaultDeps({
      mcpClients: [client],
      llmResponses: [
        {
          content: 'calling broken tool',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'brokenTool', arguments: {} }],
        },
        { content: 'recovered', finishReason: 'stop' },
      ],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('test');
    assert.ok(r.ok);
    assert.equal(r.value.content, 'recovered');
  });
});

describe('SmartAgent — unknown tool name', () => {
  it('error result "Tool not found"; loop continues', async () => {
    const { deps } = makeDefaultDeps({
      mcpClients: [],
      llmResponses: [
        {
          content: 'calling unknown',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'nonExistentTool', arguments: {} }],
        },
        { content: 'finished anyway', finishReason: 'stop' },
      ],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('test');
    assert.ok(r.ok);
    assert.equal(r.value.content, 'finished anyway');
    assert.equal(r.value.toolCallCount, 1);
  });
});

// ---------------------------------------------------------------------------
// No action
// ---------------------------------------------------------------------------

describe('SmartAgent — only fact subprompts', () => {
  it('content="", iterations=0, ok:true', async () => {
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([
        { type: 'fact', text: 'fact 1' },
        { type: 'state', text: 'state 1' },
      ]),
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('just facts');
    assert.ok(r.ok);
    assert.equal(r.value.content, '');
    assert.equal(r.value.iterations, 0);
    assert.equal(r.value.stopReason, 'stop');
  });
});

// ---------------------------------------------------------------------------
// AbortSignal
// ---------------------------------------------------------------------------

describe('SmartAgent — pre-aborted signal', () => {
  it('ABORTED, classifier not called', async () => {
    let classifierCalled = false;
    const classifier: ISubpromptClassifier = {
      async classify(): Promise<Result<Subprompt[], ClassifierError>> {
        classifierCalled = true;
        return { ok: true, value: [] };
      },
    };
    const { deps } = makeDefaultDeps({ classifier });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await agent.process('test', { signal: ctrl.signal });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
    assert.equal(classifierCalled, false);
  });
});

describe('SmartAgent — aborted mid-loop', () => {
  it('ABORTED returned on next iteration', async () => {
    const ctrl = new AbortController();
    const client = makeMcpClient([
      { name: 'tool', description: 'Tool', inputSchema: {} },
    ]);
    let llmCallCount = 0;
    const midLoopLlm: ILlm = {
      async chat(): Promise<Result<LlmResponse, LlmError>> {
        llmCallCount++;
        if (llmCallCount === 1) {
          ctrl.abort();
          return {
            ok: true,
            value: {
              content: 'iteration 1',
              finishReason: 'tool_calls',
              toolCalls: [{ id: 'c1', name: 'tool', arguments: {} }],
            },
          };
        }
        return { ok: true, value: { content: 'done', finishReason: 'stop' } };
      },
    };
    const { deps } = makeDefaultDeps({ mcpClients: [client] });
    deps.mainLlm = midLoopLlm;
    const agent = new SmartAgent(deps, { maxIterations: 10 });
    const r = await agent.process('test', { signal: ctrl.signal });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('SmartAgent — timeoutMs fires', () => {
  it('ABORTED via merged signal', async () => {
    const timeoutLlm: ILlm = {
      async chat(
        _messages: Message[],
        _tools?: LlmToolCall[],
        opts?: CallOptions,
      ): Promise<Result<LlmResponse, LlmError>> {
        return new Promise<Result<LlmResponse, LlmError>>((resolve) => {
          const id = setTimeout(
            () =>
              resolve({
                ok: true,
                value: { content: 'done', finishReason: 'stop' },
              }),
            100,
          );
          opts?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(id);
              resolve({ ok: false, error: new LlmError('Aborted', 'ABORTED') });
            },
            { once: true },
          );
        });
      },
    };
    const { deps } = makeDefaultDeps();
    deps.mainLlm = timeoutLlm;
    const agent = new SmartAgent(deps, { maxIterations: 5, timeoutMs: 20 });
    const r = await agent.process('test');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
  });
});

// ---------------------------------------------------------------------------
// Multiple clients
// ---------------------------------------------------------------------------

describe('SmartAgent — tools from two clients', () => {
  it('both tools available in catalog', async () => {
    const client1 = makeMcpClient([
      { name: 'toolA', description: 'A', inputSchema: {} },
    ]);
    const client2 = makeMcpClient([
      { name: 'toolB', description: 'B', inputSchema: {} },
    ]);
    let assembledTools: McpTool[] = [];
    const spyAssembler: IContextAssembler = {
      async assemble(
        _action: Subprompt,
        retrieved: {
          facts: RagResult[];
          feedback: RagResult[];
          state: RagResult[];
          tools: McpTool[];
        },
        _toolResults: ToolCallRecord[],
        _opts?: CallOptions,
      ): Promise<Result<Message[], AssemblerError>> {
        assembledTools = retrieved.tools;
        return { ok: true, value: [{ role: 'user', content: 'test' }] };
      },
    };
    const { deps } = makeDefaultDeps({
      mcpClients: [client1, client2],
      assembler: spyAssembler,
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('test');
    const toolNames = assembledTools.map((t) => t.name);
    assert.ok(toolNames.includes('toolA'));
    assert.ok(toolNames.includes('toolB'));
  });
});

// ---------------------------------------------------------------------------
// RAG failures
// ---------------------------------------------------------------------------

describe('SmartAgent — upsert non-fatal', () => {
  it('upsert fail → ok:true, pipeline continues', async () => {
    const failingFacts = makeFailingRag();
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([{ type: 'fact', text: 'some fact' }]),
      ragStores: { facts: failingFacts },
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('some fact');
    assert.ok(r.ok);
  });
});

describe('SmartAgent — RAG query fail non-fatal', () => {
  it('empty section → assembler receives []', async () => {
    const failingFacts = makeFailingRag();
    let assemblerFacts: RagResult[] = [
      { text: 'placeholder', score: 1, metadata: {} },
    ];
    const spyAssembler: IContextAssembler = {
      async assemble(
        _action: Subprompt,
        retrieved: {
          facts: RagResult[];
          feedback: RagResult[];
          state: RagResult[];
          tools: McpTool[];
        },
        _toolResults: ToolCallRecord[],
        _opts?: CallOptions,
      ): Promise<Result<Message[], AssemblerError>> {
        assemblerFacts = retrieved.facts;
        return { ok: true, value: [{ role: 'user', content: 'test' }] };
      },
    };
    const { deps } = makeDefaultDeps({
      ragStores: { facts: failingFacts },
      assembler: spyAssembler,
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('test');
    assert.deepEqual(assemblerFacts, []);
  });
});

// ---------------------------------------------------------------------------
// Empty classification
// ---------------------------------------------------------------------------

describe('SmartAgent — classify returns []', () => {
  it('content="", ok:true', async () => {
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([]),
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('');
    assert.ok(r.ok);
    assert.equal(r.value.content, '');
  });
});
