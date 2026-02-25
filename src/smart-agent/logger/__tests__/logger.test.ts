import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '../../../types.js';
import { SmartAgent } from '../../agent.js';
import type { IContextAssembler } from '../../interfaces/assembler.js';
import type { ISubpromptClassifier } from '../../interfaces/classifier.js';
import type { ILlm } from '../../interfaces/llm.js';
import type { IMcpClient } from '../../interfaces/mcp-client.js';
import type { IRag } from '../../interfaces/rag.js';
import {
  AssemblerError,
  type ActionNode,
  type CallOptions,
  ClassifierError,
  type ClassifierResult,
  LlmError,
  type LlmFinishReason,
  type LlmResponse,
  type LlmTool,
  type LlmToolCall,
  McpError,
  type McpTool,
  type McpToolResult,
  type RagError,
  type RagResult,
  type Result,
  type Subprompt,
  type ToolCallRecord,
} from '../../interfaces/types.js';
import { ConsoleLogger } from '../console-logger.js';
import type { ILogger, LogEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Capturing logger
// ---------------------------------------------------------------------------

function makeCapturingLogger(): ILogger & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  return {
    events,
    log(event: LogEvent): void {
      events.push(event);
    },
  };
}

// ---------------------------------------------------------------------------
// Stub factories (mirrored from agent.test.ts)
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
): ILlm {
  const queue = [...responses];
  return {
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      const next = queue.shift();
      if (!next)
        return {
          ok: true,
          value: { content: 'default', finishReason: 'stop' },
        };
      if (next instanceof Error)
        return { ok: false, error: new LlmError(next.message) };
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

function makeRag(queryResults: RagResult[] = []): IRag {
  return {
    async upsert(): Promise<Result<void, RagError>> {
      return { ok: true, value: undefined };
    },
    async query(): Promise<Result<RagResult[], RagError>> {
      return { ok: true, value: queryResults };
    },
  };
}

function makeMcpClient(
  tools: McpTool[],
  callResults?: Map<string, McpToolResult | Error>,
): IMcpClient {
  return {
    async listTools(): Promise<Result<McpTool[], McpError>> {
      return { ok: true, value: tools };
    },
    async callTool(name: string): Promise<Result<McpToolResult, McpError>> {
      const result = callResults?.get(name);
      if (result instanceof Error)
        return { ok: false, error: new McpError(result.message) };
      if (result) return { ok: true, value: result };
      return { ok: true, value: { content: `result of ${name}` } };
    },
  };
}

function makeClassifier(result: ClassifierResult | Subprompt[] | Error): ISubpromptClassifier {
  return {
    async classify(): Promise<Result<ClassifierResult, ClassifierError>> {
      if (result instanceof Error) {
        const code =
          result.message === 'ABORTED' ? 'ABORTED' : 'CLASSIFIER_ERROR';
        return { ok: false, error: new ClassifierError(result.message, code) };
      }
      if (Array.isArray(result)) {
        const stores = (result as Subprompt[])
          .filter((s) => s.type !== 'action')
          .map((s) => ({ type: s.type as 'fact' | 'feedback' | 'state', text: s.text }));
        const actions: ActionNode[] = (result as Subprompt[])
          .filter((s) => s.type === 'action')
          .map((s, i) => ({ id: i, text: s.text, dependsOn: [] }));
        return { ok: true, value: { stores, actions } };
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
    async augment(
      clientMessages: Message[],
      _ragContext: { facts: RagResult[]; feedback: RagResult[]; state: RagResult[] },
      additionalTools: LlmTool[],
      clientTools: LlmTool[],
    ): Promise<Result<{ messages: Message[]; tools: LlmTool[] }, AssemblerError>> {
      const seen = new Set<string>();
      const tools: LlmTool[] = [];
      for (const t of [...clientTools, ...additionalTools]) {
        if (!seen.has(t.name)) { seen.add(t.name); tools.push(t); }
      }
      return { ok: true, value: { messages: [...clientMessages], tools } };
    },
  };
}

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
  logger?: ILogger;
}): ConstructorParameters<typeof SmartAgent>[0] {
  return {
    mainLlm: makeLlm(
      overrides?.llmResponses ?? [{ content: 'hello', finishReason: 'stop' }],
    ),
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
    logger: overrides?.logger,
  };
}

const DEFAULT_CONFIG = { maxIterations: 5 };

// ---------------------------------------------------------------------------
// Emission — happy path
// ---------------------------------------------------------------------------

describe('Logger — classify event emitted', () => {
  it('type=classify, inputLength>0, stores/actions arrays, durationMs>=0', async () => {
    const caplog = makeCapturingLogger();
    const deps = makeDefaultDeps({ logger: caplog });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('do something');

    const ev = caplog.events.find((e) => e.type === 'classify');
    assert.ok(ev, 'classify event not found');
    assert.equal(ev.type, 'classify');
    assert.ok(ev.inputLength > 0, 'inputLength should be > 0');
    assert.ok(Array.isArray(ev.stores), 'stores should be an array');
    assert.ok(Array.isArray(ev.actions), 'actions should be an array');
    assert.ok(ev.durationMs >= 0, 'durationMs should be >= 0');
  });
});

describe('Logger — rag_query events emitted for all three stores', () => {
  it('stores = [facts, feedback, state]', async () => {
    const caplog = makeCapturingLogger();
    const deps = makeDefaultDeps({ logger: caplog });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('do something');

    const ragQueryEvents = caplog.events.filter((e) => e.type === 'rag_query');
    const storeNames = ragQueryEvents.map(
      (e) => (e as Extract<typeof e, { type: 'rag_query' }>).store,
    );
    assert.ok(storeNames.includes('facts'), 'missing facts rag_query');
    assert.ok(storeNames.includes('feedback'), 'missing feedback rag_query');
    assert.ok(storeNames.includes('state'), 'missing state rag_query');
  });
});

describe('Logger — rag_upsert emitted for non-action subprompt', () => {
  it('rag_upsert event with store=fact emitted', async () => {
    const caplog = makeCapturingLogger();
    const deps = makeDefaultDeps({
      classifier: makeClassifier([
        { type: 'fact', text: 'important fact' },
        { type: 'action', text: 'do something' },
      ]),
      logger: caplog,
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('important fact. do something');

    const upsertEv = caplog.events.find((e) => e.type === 'rag_upsert');
    assert.ok(upsertEv, 'rag_upsert event not found');
    assert.equal(
      (upsertEv as Extract<typeof upsertEv, { type: 'rag_upsert' }>).store,
      'fact',
    );
  });
});

describe('Logger — llm_call event emitted', () => {
  it('iteration=0, finishReason=stop, durationMs>=0', async () => {
    const caplog = makeCapturingLogger();
    const deps = makeDefaultDeps({
      llmResponses: [{ content: 'answer', finishReason: 'stop' }],
      logger: caplog,
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('do something');

    const ev = caplog.events.find((e) => e.type === 'llm_call');
    assert.ok(ev, 'llm_call event not found');
    const llmEv = ev as Extract<typeof ev, { type: 'llm_call' }>;
    assert.equal(llmEv.iteration, 0);
    assert.equal(llmEv.finishReason, 'stop');
    assert.ok(llmEv.durationMs >= 0);
  });
});

describe('Logger — tool_call event emitted on successful tool execution', () => {
  it('toolName correct, isError=false', async () => {
    const caplog = makeCapturingLogger();
    const client = makeMcpClient(
      [{ name: 'search', description: 'Search', inputSchema: {} }],
      new Map([['search', { content: 'result' }]]),
    );
    const deps = makeDefaultDeps({
      mcpClients: [client],
      llmResponses: [
        {
          content: 'searching',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'search', arguments: {} }],
        },
        { content: 'done', finishReason: 'stop' },
      ],
      logger: caplog,
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('search for something');

    const ev = caplog.events.find((e) => e.type === 'tool_call');
    assert.ok(ev, 'tool_call event not found');
    const tcEv = ev as Extract<typeof ev, { type: 'tool_call' }>;
    assert.equal(tcEv.toolName, 'search');
    assert.equal(tcEv.isError, false);
  });
});

describe('Logger — pipeline_done event emitted', () => {
  it('stopReason=stop, iterations>=1, toolCallCount>=0, durationMs>=0', async () => {
    const caplog = makeCapturingLogger();
    const deps = makeDefaultDeps({
      llmResponses: [{ content: 'hello', finishReason: 'stop' }],
      logger: caplog,
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('do something');

    const ev = caplog.events.find((e) => e.type === 'pipeline_done');
    assert.ok(ev, 'pipeline_done event not found');
    const doneEv = ev as Extract<typeof ev, { type: 'pipeline_done' }>;
    assert.equal(doneEv.stopReason, 'stop');
    assert.ok(doneEv.iterations >= 1);
    assert.ok(doneEv.toolCallCount >= 0);
    assert.ok(doneEv.durationMs >= 0);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('Logger — pipeline_error on classifier failure', () => {
  it('code=CLASSIFIER_ERROR', async () => {
    const caplog = makeCapturingLogger();
    const deps = makeDefaultDeps({
      classifier: makeClassifier(new Error('classify failed')),
      logger: caplog,
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('test');

    const ev = caplog.events.find((e) => e.type === 'pipeline_error');
    assert.ok(ev, 'pipeline_error event not found');
    const errEv = ev as Extract<typeof ev, { type: 'pipeline_error' }>;
    assert.equal(errEv.code, 'CLASSIFIER_ERROR');
  });
});

describe('Logger — pipeline_error on LLM failure', () => {
  it('code=LLM_ERROR', async () => {
    const caplog = makeCapturingLogger();
    const deps = makeDefaultDeps({
      llmResponses: [new Error('LLM down')],
      logger: caplog,
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('test');

    const ev = caplog.events.find((e) => e.type === 'pipeline_error');
    assert.ok(ev, 'pipeline_error event not found');
    const errEv = ev as Extract<typeof ev, { type: 'pipeline_error' }>;
    assert.equal(errEv.code, 'LLM_ERROR');
  });
});

describe('Logger — tool_call isError=true on MCP tool failure', () => {
  it('isError=true when MCP returns error', async () => {
    const caplog = makeCapturingLogger();
    const client = makeMcpClient(
      [{ name: 'brokenTool', description: 'Broken', inputSchema: {} }],
      new Map([['brokenTool', new Error('tool failed')]]),
    );
    const deps = makeDefaultDeps({
      mcpClients: [client],
      llmResponses: [
        {
          content: 'calling broken',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'brokenTool', arguments: {} }],
        },
        { content: 'recovered', finishReason: 'stop' },
      ],
      logger: caplog,
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('test');

    const ev = caplog.events.find((e) => e.type === 'tool_call');
    assert.ok(ev, 'tool_call event not found');
    const tcEv = ev as Extract<typeof ev, { type: 'tool_call' }>;
    assert.equal(tcEv.isError, true);
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('Logger — classify event has no sensitive keys', () => {
  it('no text, content, or inputText keys in event', async () => {
    const caplog = makeCapturingLogger();
    const deps = makeDefaultDeps({ logger: caplog });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('do something');

    const ev = caplog.events.find((e) => e.type === 'classify') as
      | Record<string, unknown>
      | undefined;
    assert.ok(ev);
    assert.ok(!('text' in ev), 'classify event must not contain text');
    assert.ok(!('content' in ev), 'classify event must not contain content');
    assert.ok(
      !('inputText' in ev),
      'classify event must not contain inputText',
    );
  });
});

describe('Logger — rag_query event has no sensitive keys', () => {
  it('no queryText, document, or content keys in event', async () => {
    const caplog = makeCapturingLogger();
    const deps = makeDefaultDeps({ logger: caplog });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('do something');

    const ev = caplog.events.find((e) => e.type === 'rag_query') as
      | Record<string, unknown>
      | undefined;
    assert.ok(ev);
    assert.ok(!('queryText' in ev), 'rag_query must not contain queryText');
    assert.ok(!('document' in ev), 'rag_query must not contain document');
    assert.ok(!('content' in ev), 'rag_query must not contain content');
  });
});

describe('Logger — tool_call event has no sensitive keys', () => {
  it('no arguments or args keys in event', async () => {
    const caplog = makeCapturingLogger();
    const client = makeMcpClient(
      [{ name: 'myTool', description: 'Tool', inputSchema: {} }],
      new Map([['myTool', { content: 'ok' }]]),
    );
    const deps = makeDefaultDeps({
      mcpClients: [client],
      llmResponses: [
        {
          content: 'calling',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'c1', name: 'myTool', arguments: { secret: 'password123' } },
          ],
        },
        { content: 'done', finishReason: 'stop' },
      ],
      logger: caplog,
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('test');

    const ev = caplog.events.find((e) => e.type === 'tool_call') as
      | Record<string, unknown>
      | undefined;
    assert.ok(ev);
    assert.ok(!('arguments' in ev), 'tool_call must not contain arguments');
    assert.ok(!('args' in ev), 'tool_call must not contain args');
  });
});

// ---------------------------------------------------------------------------
// traceId propagation
// ---------------------------------------------------------------------------

describe('Logger — traceId from CallOptions.trace propagated to all events', () => {
  it('all events share the provided traceId', async () => {
    const caplog = makeCapturingLogger();
    const deps = makeDefaultDeps({ logger: caplog });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const customTraceId = 'my-trace-id-12345';
    await agent.process('do something', { trace: { traceId: customTraceId } });

    assert.ok(caplog.events.length > 0, 'no events emitted');
    for (const ev of caplog.events) {
      assert.equal(
        ev.traceId,
        customTraceId,
        `event ${ev.type} has wrong traceId: ${ev.traceId}`,
      );
    }
  });
});

describe('Logger — auto-generated traceId is UUID and consistent across events', () => {
  it('all events share the same auto-generated UUID traceId', async () => {
    const caplog = makeCapturingLogger();
    const deps = makeDefaultDeps({ logger: caplog });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('do something');

    assert.ok(caplog.events.length > 0, 'no events emitted');
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const firstTraceId = caplog.events[0].traceId;
    assert.match(firstTraceId, uuidRegex, 'traceId is not a UUID');
    for (const ev of caplog.events) {
      assert.equal(
        ev.traceId,
        firstTraceId,
        `event ${ev.type} has different traceId`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// ConsoleLogger
// ---------------------------------------------------------------------------

describe('ConsoleLogger — enabled=true writes JSON to stderr', () => {
  it('valid JSON line with timestamp written to stderr', () => {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: spy override
    (process.stderr as any).write = (chunk: string) => {
      lines.push(chunk);
      return true;
    };

    try {
      const logger = new ConsoleLogger(true);
      logger.log({
        type: 'classify',
        traceId: 'tid',
        inputLength: 10,
        stores: [],
        actions: [],
        durationMs: 5,
      });
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stderr as any).write = original;
    }

    assert.equal(
      lines.length,
      1,
      'expected exactly one line written to stderr',
    );
    const parsed = JSON.parse(lines[0].trim()) as Record<string, unknown>;
    assert.ok('timestamp' in parsed, 'missing timestamp field');
    assert.equal(parsed.type, 'classify');
  });
});

describe('ConsoleLogger — enabled=false is silent', () => {
  it('no output to stderr when disabled', () => {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: spy override
    (process.stderr as any).write = (chunk: string) => {
      lines.push(chunk);
      return true;
    };

    try {
      const logger = new ConsoleLogger(false);
      logger.log({
        type: 'classify',
        traceId: 'tid',
        inputLength: 10,
        stores: [],
        actions: [],
        durationMs: 5,
      });
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stderr as any).write = original;
    }

    assert.equal(lines.length, 0, 'expected no output to stderr');
  });
});
