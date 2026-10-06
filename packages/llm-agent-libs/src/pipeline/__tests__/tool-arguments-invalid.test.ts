/**
 * Spec §10.5.2 N2 (D87): a tool call whose argument text is not valid JSON is
 * marked (`argumentsError`) and never run — its tool result is the error. Every
 * site that parses argument text marks; every site that runs a tool refuses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  AgentStreamChunk,
  ILlm,
  IModelInfo,
  LLMProvider,
  LLMResponse,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  Message,
  Result,
  StreamToolCall,
} from '@mcp-abap-adt/llm-agent';
import { LlmAdapter } from '../../adapters/llm-adapter.js';
import { LlmProviderBridge } from '../../adapters/llm-provider-bridge.js';
import { SmartAgent } from '../../agent.js';
import { makeDefaultDeps, makeMcpClient } from '../../testing/index.js';
import { DefaultPipeline } from '../default-pipeline.js';

const BAD = '{"a":';
const CODE_RE = /TOOL_ARGUMENTS_JSON_PARSE_FAILED/;

/** An LLM that streams `first` tool calls once, then answers 'done'; records every request. */
function scriptedLlm(
  first: StreamToolCall[],
): ILlm & { requests: Message[][] } {
  const requests: Message[][] = [];
  let call = 0;
  return {
    requests,
    model: 'scripted',
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return { ok: true, value: { content: 'unused', finishReason: 'stop' } };
    },
    async *streamChat(
      messages: Message[],
    ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      requests.push([...messages]);
      call++;
      if (call === 1) {
        yield {
          ok: true,
          value: { content: '', toolCalls: first, finishReason: 'tool_calls' },
        };
        return;
      }
      yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
    },
    async healthCheck() {
      return { ok: true as const, value: true };
    },
  } as ILlm & { requests: Message[][] };
}

function stepLogger(): {
  steps: Array<{ name: string; data: unknown }>;
  sessionLogger: { logStep(name: string, data: unknown): void };
} {
  const steps: Array<{ name: string; data: unknown }> = [];
  return {
    steps,
    sessionLogger: {
      logStep(name: string, data: unknown) {
        steps.push({ name, data });
      },
    },
  };
}

function toolMessages(requests: Message[][]): Message[] {
  return (requests[1] ?? []).filter((m) => m.role === 'tool');
}

async function runThroughPipeline(first: StreamToolCall[]) {
  const llm = scriptedLlm(first);
  const client = makeMcpClient([
    { name: 'sum', description: 'sum', inputSchema: {} },
  ]);
  const { deps } = makeDefaultDeps({ mcpClients: [client] });
  const pipeline = new DefaultPipeline();
  pipeline.initialize({
    ...deps,
    mainLlm: llm,
    agentConfig: { mode: 'hard', maxIterations: 5 },
  } as never);
  const agent = new SmartAgent(
    { ...deps, mainLlm: llm, pipeline },
    { maxIterations: 5, mode: 'hard' },
  );
  const log = stepLogger();
  const r = await agent.process('add', { sessionLogger: log.sessionLogger });
  return { r, llm, client, steps: log.steps };
}

describe('tool-loop (DefaultPipeline): invalid argument text never runs a tool', () => {
  it('streamed deltas with bad JSON → tool not called, tool message carries the code, step logged', async () => {
    const { r, llm, client, steps } = await runThroughPipeline([
      { index: 0, id: 'c1', name: 'sum', arguments: BAD },
    ]);
    assert.ok(r.ok, !r.ok ? r.error.message : '');
    assert.equal(client.callCount, 0, 'the tool must not run with {}');
    const tools = toolMessages(llm.requests);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool_call_id, 'c1');
    assert.match(String(tools[0].content), CODE_RE);
    assert.match(String(tools[0].content), /arguments of tool "sum"/);
    const step = steps.find((s) => s.name === 'tool_arguments_invalid');
    assert.ok(step, 'tool_arguments_invalid logged');
    const data = step.data as { tool: string; code: string; error: string };
    assert.equal(data.tool, 'sum');
    assert.equal(data.code, 'TOOL_ARGUMENTS_JSON_PARSE_FAILED');
    assert.ok(data.error.length > 0);
  });

  it('a call an adapter already marked is refused with no second parse', async () => {
    const { client, llm } = await runThroughPipeline([
      {
        id: 'c1',
        name: 'sum',
        arguments: {},
        argumentsError: 'SyntaxError: x',
      },
    ]);
    assert.equal(client.callCount, 0);
    const tools = toolMessages(llm.requests);
    assert.equal(tools.length, 1);
    assert.match(String(tools[0].content), CODE_RE);
    assert.match(String(tools[0].content), /SyntaxError: x/);
  });

  it('valid JSON and empty argument text still run the tool', async () => {
    const valid = await runThroughPipeline([
      { index: 0, id: 'c1', name: 'sum', arguments: '{"a":1}' },
    ]);
    assert.equal(valid.client.callCount, 1);
    const empty = await runThroughPipeline([
      { index: 0, id: 'c1', name: 'sum', arguments: '' },
    ]);
    assert.equal(empty.client.callCount, 1);
  });
});

describe('legacy SmartAgent loop (no pipeline): invalid argument text never runs a tool', () => {
  it('bad JSON → tool not called, tool message carries the code', async () => {
    const llm = scriptedLlm([
      { index: 0, id: 'c1', name: 'sum', arguments: BAD },
    ]);
    const client = makeMcpClient([
      { name: 'sum', description: 'sum', inputSchema: {} },
    ]);
    const { deps } = makeDefaultDeps({ mcpClients: [client] });
    const agent = new SmartAgent(
      { ...deps, mainLlm: llm },
      { maxIterations: 5, mode: 'hard' },
    );
    const log = stepLogger();
    const r = await agent.process('add', { sessionLogger: log.sessionLogger });
    assert.ok(r.ok, !r.ok ? r.error.message : '');
    assert.equal(client.callCount, 0);
    const tools = toolMessages(llm.requests);
    assert.equal(tools.length, 1);
    assert.match(String(tools[0].content), CODE_RE);
    assert.ok(log.steps.some((s) => s.name === 'tool_arguments_invalid'));
  });
});

class StubProvider implements LLMProvider {
  readonly model = 'stub';
  constructor(private readonly chunks: LLMResponse[]) {}
  async chat(): Promise<LLMResponse> {
    return { content: '' };
  }
  async *streamChat(_m: Message[]): AsyncIterable<LLMResponse> {
    for (const c of this.chunks) yield c;
  }
  async getModels(): Promise<IModelInfo[]> {
    return [];
  }
  async getEmbeddingModels(): Promise<IModelInfo[]> {
    return [];
  }
}

async function bridgeCalls(args: string | undefined) {
  const provider = new StubProvider([
    {
      content: '',
      toolCalls: [{ index: 0, id: 'c1', name: 'sum', arguments: args }],
    },
    { content: '', finishReason: 'tool_calls' },
  ]);
  const out: AgentStreamChunk[] = [];
  for await (const c of new LlmProviderBridge(provider).streamWithTools(
    [{ role: 'user', content: 'hi' }],
    [],
  )) {
    out.push(c as AgentStreamChunk);
  }
  const chunk = out.find((c) => c.type === 'tool_calls');
  assert.ok(chunk && chunk.type === 'tool_calls');
  return chunk.toolCalls;
}

describe('llm-provider-bridge: the tool_calls chunk marks unparseable arguments', () => {
  it('bad JSON → argumentsError set, arguments {}', async () => {
    const [call] = await bridgeCalls(BAD);
    assert.deepEqual(call.arguments, {});
    assert.equal(typeof call.argumentsError, 'string');
    assert.ok((call.argumentsError ?? '').length > 0);
  });

  it('valid JSON and no argument text carry no mark', async () => {
    const [valid] = await bridgeCalls('{"a":1}');
    assert.deepEqual(valid.arguments, { a: 1 });
    assert.equal(valid.argumentsError, undefined);
    const [none] = await bridgeCalls(undefined);
    assert.deepEqual(none.arguments, {});
    assert.equal(none.argumentsError, undefined);
  });
});

function openAiAdapter(args: string) {
  const raw = {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            { id: 'c1', function: { name: 'sum', arguments: args } },
          ],
        },
      },
    ],
  };
  return new LlmAdapter({
    async callWithTools() {
      return { content: '', raw };
    },
    async *streamWithTools() {
      yield { content: '', raw };
    },
  });
}

describe('llm-adapter (OpenAI format): the LlmToolCall marks unparseable arguments', () => {
  it('bad JSON → argumentsError set, arguments {}, diagnostic emitted', async () => {
    const log = stepLogger();
    const r = await openAiAdapter(BAD).chat(
      [{ role: 'user', content: 'hi' }],
      undefined,
      { sessionLogger: log.sessionLogger },
    );
    assert.ok(r.ok);
    const call = r.value.toolCalls?.[0];
    assert.deepEqual(call?.arguments, {});
    assert.ok((call?.argumentsError ?? '').length > 0);
    assert.equal(
      log.steps.filter((s) => s.name === 'llm_parse_diagnostic').length,
      1,
    );
  });

  it('valid JSON and empty argument text carry no mark', async () => {
    const valid = await openAiAdapter('{"a":1}').chat([
      { role: 'user', content: 'hi' },
    ]);
    assert.ok(valid.ok);
    assert.equal(valid.value.toolCalls?.[0].argumentsError, undefined);
    const empty = await openAiAdapter('').chat([
      { role: 'user', content: 'hi' },
    ]);
    assert.ok(empty.ok);
    assert.deepEqual(empty.value.toolCalls?.[0].arguments, {});
    assert.equal(empty.value.toolCalls?.[0].argumentsError, undefined);
  });

  it('the tool loop does not run a call the adapter marked', async () => {
    const adapter = openAiAdapter(BAD);
    const requests: Message[][] = [];
    let n = 0;
    const llm = {
      model: 'adapter',
      async chat(messages: Message[]) {
        requests.push([...messages]);
        n++;
        if (n === 1) return adapter.chat(messages);
        return {
          ok: true as const,
          value: { content: 'done', finishReason: 'stop' as const },
        };
      },
      async *streamChat(
        messages: Message[],
      ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        const r = await llm.chat(messages);
        if (!r.ok) {
          yield r;
          return;
        }
        yield {
          ok: true,
          value: {
            content: r.value.content,
            toolCalls: r.value.toolCalls,
            finishReason: r.value.toolCalls ? 'tool_calls' : 'stop',
          },
        };
      },
    } as unknown as ILlm;
    const client = makeMcpClient([
      { name: 'sum', description: 'sum', inputSchema: {} },
    ]);
    const { deps } = makeDefaultDeps({ mcpClients: [client] });
    const pipeline = new DefaultPipeline();
    pipeline.initialize({
      ...deps,
      mainLlm: llm,
      agentConfig: { mode: 'hard', maxIterations: 5 },
    } as never);
    const agent = new SmartAgent(
      { ...deps, mainLlm: llm, pipeline },
      { maxIterations: 5, mode: 'hard' },
    );
    const r = await agent.process('add');
    assert.ok(r.ok, !r.ok ? r.error.message : '');
    assert.equal(client.callCount, 0);
    const tools = (requests[1] ?? []).filter((m) => m.role === 'tool');
    assert.equal(tools.length, 1);
    assert.match(String(tools[0].content), CODE_RE);
  });
});

describe('a mixed round: the valid sibling runs, the bad call gets the error (fix round 1)', () => {
  const mixed: StreamToolCall[] = [
    { index: 0, id: 'c1', name: 'sum', arguments: BAD },
    { index: 1, id: 'c2', name: 'sum', arguments: '{"a":1}' },
  ];

  function assertMixed(llm: { requests: Message[][] }, callCount: number) {
    assert.equal(callCount, 1, 'the valid call runs exactly once');
    const tools = toolMessages(llm.requests);
    const bad = tools.find((m) => m.tool_call_id === 'c1');
    const good = tools.find((m) => m.tool_call_id === 'c2');
    assert.match(String(bad?.content), CODE_RE);
    assert.ok(good, 'the valid call has its tool result');
    assert.doesNotMatch(String(good.content), CODE_RE);
  }

  it('tool-loop (DefaultPipeline)', async () => {
    const { r, llm, client } = await runThroughPipeline(mixed);
    assert.ok(r.ok, !r.ok ? r.error.message : '');
    assertMixed(llm, client.callCount);
  });

  it('legacy SmartAgent loop', async () => {
    const llm = scriptedLlm(mixed);
    const client = makeMcpClient([
      { name: 'sum', description: 'sum', inputSchema: {} },
    ]);
    const { deps } = makeDefaultDeps({ mcpClients: [client] });
    const agent = new SmartAgent(
      { ...deps, mainLlm: llm },
      { maxIterations: 5, mode: 'hard' },
    );
    const r = await agent.process('add');
    assert.ok(r.ok, !r.ok ? r.error.message : '');
    assertMixed(llm, client.callCount);
  });
});

describe('legacy SmartAgent loop: external calls reach the consumer only after the check (fix round 1)', () => {
  const EXTERNAL = {
    name: 'GenerateFile',
    description: 'Generate a file',
    inputSchema: { type: 'object' as const, properties: {} },
  };

  it('an external call with bad JSON is not surfaced to the consumer', async () => {
    const llm = scriptedLlm([
      { index: 0, id: 'c1', name: 'GenerateFile', arguments: BAD },
    ]);
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(
      { ...deps, mainLlm: llm },
      { maxIterations: 5, mode: 'hard' },
    );
    const r = await agent.process('gen', { externalTools: [EXTERNAL] });
    assert.ok(r.ok, !r.ok ? r.error.message : '');
    assert.equal(r.value.toolCalls, undefined, 'no unchecked call surfaced');
    const tools = toolMessages(llm.requests);
    assert.match(String(tools[0]?.content), CODE_RE);
  });

  it('a valid external call is surfaced once, with its parsed arguments', async () => {
    const llm = scriptedLlm([
      { index: 0, id: 'c1', name: 'GenerateFile', arguments: '{"f":' },
      { index: 0, arguments: '"x"}' },
    ]);
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(
      { ...deps, mainLlm: llm },
      { maxIterations: 5, mode: 'hard' },
    );
    const r = await agent.process('gen', { externalTools: [EXTERNAL] });
    assert.ok(r.ok, !r.ok ? r.error.message : '');
    assert.equal(r.value.stopReason, 'tool_calls');
    assert.equal(r.value.toolCalls?.length, 1);
    assert.equal(r.value.toolCalls?.[0].function.name, 'GenerateFile');
    assert.deepEqual(
      JSON.parse(r.value.toolCalls?.[0].function.arguments ?? ''),
      { f: 'x' },
    );
  });
});
