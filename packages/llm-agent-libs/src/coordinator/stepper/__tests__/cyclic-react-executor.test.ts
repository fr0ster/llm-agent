import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OnPartial, StreamChunk } from '@mcp-abap-adt/llm-agent';
import { ClarifySignal, TokenLedger } from '@mcp-abap-adt/llm-agent';
import { CyclicReActExecutor } from '../cyclic-react-executor.js';
import { RegexNeedResolver } from '../need-resolver.js';

// A scripted LLM: returns queued responses in order.
function scriptedLlm(
  responses: Array<{
    content: string;
    toolCalls?: { name: string; arguments: unknown }[];
    usage?: unknown;
  }>,
) {
  let i = 0;
  return {
    name: 'stub',
    async chat() {
      const r = responses[Math.min(i++, responses.length - 1)];
      return {
        ok: true as const,
        value: {
          content: r.content,
          toolCalls: r.toolCalls,
          usage: r.usage ?? {
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
          },
        },
      };
    },
  };
}

// A scripted MCP dispatcher: name → result.
function mcp(results: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    async call(name: string) {
      calls.push(name);
      return results[name] ?? '<no result>';
    },
  };
}

const META_BASE = {
  identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n1' },
  toolSafety: {
    mutationPolicy: 'confirm' as const,
    knownReadOnlyTools: new Set(['ReadProgram']),
  },
};

function knowledgeStub() {
  const writes: { content: string; artifactType: string }[] = [];
  return {
    writes,
    rag: {
      async query() {
        return [];
      },
      async list() {
        return [];
      },
      async write(e: { content: string; metadata: { artifactType: string } }) {
        writes.push({
          content: e.content,
          artifactType: e.metadata.artifactType,
        });
      },
      fingerprint() {
        return 'n=0';
      },
    },
  };
}

function toolsStub(
  tools: Record<string, { name: string; readOnly?: boolean }>,
) {
  return {
    async query() {
      return Object.values(tools);
    },
    lookup(name: string) {
      return tools[name];
    },
  };
}

test('H.1 context-augmenting ReAct: need → inject tool → final answer', async () => {
  // turn 1: "I can't read the program" → resolver pulls ReadProgram
  // turn 2: tool-call ReadProgram → executes
  // turn 3: clean final answer
  const llm = scriptedLlm([
    { content: "I can't read the program source" },
    {
      content: 'reading',
      toolCalls: [{ name: 'ReadProgram', arguments: { p: 'Z' } }],
    },
    { content: 'Final analysis: looks fine.' },
  ]);
  const m = mcp({ ReadProgram: 'REPORT z.' });
  const { rag, writes } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  const res = await exec.execute({
    prompt: 'analyse program Z',
    tools: [],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({
      ReadProgram: { name: 'ReadProgram', readOnly: true },
    }) as never,
    needResolver: new RegexNeedResolver(),
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.equal(res.status, 'ok');
  assert.deepEqual(m.calls, ['ReadProgram']);
  assert.ok(writes.some((w) => w.content === 'REPORT z.')); // mcp result written
  assert.ok(writes.some((w) => w.content.includes('Final analysis'))); // final answer written
});

test('H.5 mutating tool without readOnly raises ClarifySignal before call', async () => {
  const llm = scriptedLlm([
    {
      content: 'creating',
      toolCalls: [{ name: 'CreateClass', arguments: { n: 'ZCL' } }],
    },
  ]);
  const m = mcp({ CreateClass: 'created' });
  const { rag } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  await assert.rejects(
    () =>
      exec.execute({
        prompt: 'create class ZCL',
        tools: [],
        knowledgeRag: rag as never,
        toolsRag: toolsStub({ CreateClass: { name: 'CreateClass' } }) as never, // no readOnly
        budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
        ...META_BASE,
      }),
    (e: unknown) =>
      e instanceof ClarifySignal &&
      /CreateClass/.test((e as ClarifySignal).question),
  );
  assert.deepEqual(m.calls, []); // NOT executed
});

test('H.5b knownReadOnlyTools allowlist bypasses confirmation', async () => {
  const llm = scriptedLlm([
    { content: 'reading', toolCalls: [{ name: 'ReadProgram', arguments: {} }] },
    { content: 'done' },
  ]);
  const m = mcp({ ReadProgram: 'src' });
  const { rag } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  const res = await exec.execute({
    prompt: 'read',
    tools: [],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({ ReadProgram: { name: 'ReadProgram' } }) as never, // no readOnly field
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE, // but in knownReadOnlyTools
  });
  assert.equal(res.status, 'ok');
  assert.deepEqual(m.calls, ['ReadProgram']);
});

test('budget-exhausted when the shared token ledger is exhausted', async () => {
  const llm = scriptedLlm([
    {
      content: 'x',
      toolCalls: [{ name: 'ReadProgram', arguments: {} }],
      usage: { promptTokens: 60000, completionTokens: 0, totalTokens: 60000 },
    },
    {
      content: 'y',
      toolCalls: [{ name: 'ReadProgram', arguments: {} }],
      usage: { promptTokens: 60000, completionTokens: 0, totalTokens: 60000 },
    },
  ]);
  const m = mcp({ ReadProgram: 'src' });
  const { rag } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  const res = await exec.execute({
    prompt: 'read',
    tools: [],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({
      ReadProgram: { name: 'ReadProgram', readOnly: true },
    }) as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  // The first tool-call response spends 60k (ledger 40k left), loops; second
  // spends 60k → ledger -20k; the THIRD top-of-loop check sees exhausted and
  // bubbles budget-exhausted BEFORE making another call (wants more work, no
  // budget). This is the gate the budget-extension clarify depends on.
  assert.equal(res.status, 'budget-exhausted');
});

// ── Always-on need analysis (deps-injected resolver) ─────────────────────────
// These cover the core 18.x fix: the executor must ALWAYS inspect a no-tool-call
// answer for an unmet-tool need, gated by the (classifier) resolver — not a
// brittle last-line regex, and not left undefined by a missing thread-through.

// A fake INeedResolver scripted per resolve() call.
function fakeResolver(verdicts: Array<{ queryToolsRag: string } | undefined>): {
  resolve(r: string): Promise<{ queryToolsRag: string } | undefined>;
} {
  let i = 0;
  return {
    async resolve() {
      return verdicts[Math.min(i++, verdicts.length - 1)];
    },
  };
}

// A query-aware toolsRag: maps the query string → tools to return.
function toolsByQuery(
  byQuery: (q: string) => { name: string; readOnly?: boolean }[],
  lookupMap: Record<string, { name: string; readOnly?: boolean }> = {},
): {
  query(q: string): Promise<{ name: string; readOnly?: boolean }[]>;
  lookup(name: string): { name: string; readOnly?: boolean } | undefined;
} {
  return {
    async query(q: string) {
      return byQuery(q);
    },
    lookup(name: string) {
      return lookupMap[name];
    },
  };
}

test('always-on need (deps-injected): classifier signals need → new tool injected → ok', async () => {
  // turn 1: free-text "I need the include files" (NOT matched by the old regex)
  // turn 2: clean answer → classifier says no-need → ok
  const llm = scriptedLlm([
    {
      content:
        'I have the main program, but I need the include files to finish.',
    },
    { content: 'Final review complete.' },
  ]);
  const m = mcp({});
  const { rag } = knowledgeStub();
  let needQuery: string | undefined;
  const toolsRag = toolsByQuery(
    (q) => {
      if (q === 'read include source') {
        needQuery = q;
        return [{ name: 'GetInclude', readOnly: true }];
      }
      return []; // seed query (prompt) finds nothing
    },
    { GetInclude: { name: 'GetInclude', readOnly: true } },
  );
  const resolver = fakeResolver([
    { queryToolsRag: 'read include source' }, // turn 1 → need
    undefined, // turn 2 → satisfied
  ]);
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
    needResolver: resolver as never, // injected via DEPS, not input
  });
  const res = await exec.execute({
    prompt: 'review program Z',
    tools: [],
    knowledgeRag: rag as never,
    toolsRag: toolsRag as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.equal(res.status, 'ok');
  assert.equal(
    needQuery,
    'read include source',
    're-query used the capability',
  );
});

test('false-positive guard: classifier says no-need → ok with NO tool re-query (even if toolsRag has tools)', async () => {
  const llm = scriptedLlm([{ content: 'Everything looks fine. Done.' }]);
  const m = mcp({});
  const { rag } = knowledgeStub();
  let queryCount = 0;
  const toolsRag = {
    async query() {
      queryCount++;
      return [{ name: 'GetInclude', readOnly: true }];
    },
    lookup() {
      return undefined;
    },
  };
  const resolver = fakeResolver([undefined]); // classifier: never a need
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
    needResolver: resolver as never,
  });
  const res = await exec.execute({
    prompt: 'review Z',
    tools: [{ name: 'seed' }], // non-empty → skip proactive seeding query
    knowledgeRag: rag as never,
    toolsRag: toolsRag as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.equal(res.status, 'ok');
  assert.equal(
    queryCount,
    0,
    'no tool re-query when classifier gate says no-need',
  );
});

test('stuck need with no NEW tools → incomplete (bounded, no infinite loop)', async () => {
  const llm = scriptedLlm([
    { content: 'I need a tool.' },
    { content: 'Still need a tool.' },
    { content: 'Need it.' },
  ]);
  const m = mcp({});
  const { rag } = knowledgeStub();
  const toolsRag = toolsByQuery(() => [{ name: 'Foo', readOnly: true }], {
    Foo: { name: 'Foo', readOnly: true },
  });
  const resolver = fakeResolver([{ queryToolsRag: 'foo' }]); // always a need
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
    needResolver: resolver as never,
  });
  const res = await exec.execute({
    prompt: 'do x',
    tools: [{ name: 'Foo' }], // Foo already present → re-query never adds anything new
    knowledgeRag: rag as never,
    toolsRag: toolsRag as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.equal(res.status, 'incomplete');
  assert.ok(
    res.missing && res.missing.length > 0,
    'reports the missing capability',
  );
});

test('executor injects shared knowledge-RAG facts/guidance into its prompt (makes seeded guidance effective)', async () => {
  // A seeded guidance fact lives in the session blackboard. The executor must
  // surface it to its LLM — otherwise seeded tool-usage rules never reach the
  // component that actually chooses tools (the cyclic-react planner is trivial).
  let firstUserContent = '';
  const llm = {
    name: 'stub',
    async chat(messages: Array<{ role: string; content: string }>) {
      if (!firstUserContent) {
        const u = messages.find((m) => m.role === 'user');
        firstUserContent = u?.content ?? '';
      }
      return {
        ok: true as const,
        value: {
          content: 'Done.',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      };
    },
  };
  const ragWithFact = {
    async query() {
      return [
        {
          content: 'Read an INCLUDE body ONLY via GetInclude.',
          metadata: { artifactType: 'guidance', createdAt: 'x' },
        },
      ];
    },
    async list() {
      return [];
    },
    async write() {},
    fingerprint() {
      return 'n=1';
    },
  };
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: mcp({}).call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  await exec.execute({
    prompt: 'review program Z',
    tools: [{ name: 'seed' }], // non-empty → skip proactive tool seeding
    knowledgeRag: ragWithFact as never,
    toolsRag: toolsStub({}) as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.match(
    firstUserContent,
    /GetInclude/,
    'the seeded guidance fact must appear in the executor LLM prompt',
  );
});

test('tool-seeding query is enriched with knowledge-RAG guidance BEFORE vectorization (contextual-RAG-then-tool-search order)', async () => {
  // The crux: seeded guidance must steer WHICH tools surface. The executor must
  // enrich the tool-search text with the knowledge-RAG context first, then
  // vectorize THAT — otherwise a "review program" prompt never ranks GetInclude
  // and the model falls back to the wrong tool.
  let toolQuery = '';
  const toolsRag = {
    async query(text: string) {
      toolQuery = text;
      return [{ name: 'GetInclude', readOnly: true }];
    },
    lookup(n: string) {
      return n === 'GetInclude' ? { name: 'GetInclude', readOnly: true } : undefined;
    },
  };
  const ragWithGuidance = {
    async query() {
      return [
        {
          content: 'Read an INCLUDE body ONLY via GetInclude.',
          metadata: { artifactType: 'guidance', createdAt: 'x' },
        },
      ];
    },
    async list() {
      return [];
    },
    async write() {},
    fingerprint() {
      return 'n=1';
    },
  };
  const llm = scriptedLlm([{ content: 'Done.' }]);
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: mcp({}).call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  await exec.execute({
    prompt: 'review program Z',
    tools: [], // empty → triggers proactive seeding
    knowledgeRag: ragWithGuidance as never,
    toolsRag: toolsRag as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.match(
    toolQuery,
    /GetInclude/,
    'tool-search query must carry the seeded guidance, not just the bare prompt',
  );
});

test('tool-relay builds protocol-correct messages: assistant carries tool_calls, tool carries tool_call_id (the live 400 fix)', async () => {
  // Reproduces the live SAP AI SDK 400: the executor pushed an assistant message
  // WITHOUT tool_calls and tool messages WITHOUT tool_call_id, so the 2nd turn's
  // tool_result was orphaned and Anthropic/SAP rejected it. We assert the wire
  // shape mirrors the working 17.0 tool-loop pattern.
  const seen: Array<
    Array<{
      role: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
      tool_call_id?: string;
    }>
  > = [];
  const llm = {
    name: 'stub',
    async chat(
      messages: Array<{
        role: string;
        tool_calls?: never;
        tool_call_id?: string;
      }>,
    ) {
      seen.push(
        messages.map((m) => ({
          role: m.role,
          tool_calls: (
            m as {
              tool_calls?: Array<{
                id: string;
                type: string;
                function: { name: string; arguments: string };
              }>;
            }
          ).tool_calls,
          tool_call_id: m.tool_call_id,
        })),
      );
      if (seen.length === 1) {
        return {
          ok: true as const,
          value: {
            content: 'reading',
            toolCalls: [
              { id: 'tc1', name: 'ReadProgram', arguments: { p: 'Z' } },
            ],
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          },
        };
      }
      return {
        ok: true as const,
        value: {
          content: 'Done.',
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        },
      };
    },
  };
  const m = mcp({ ReadProgram: 'REPORT z.' });
  const { rag } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  const res = await exec.execute({
    prompt: 'read Z',
    tools: [],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({
      ReadProgram: { name: 'ReadProgram', readOnly: true },
    }) as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.equal(res.status, 'ok');
  // The SECOND LLM call's history must carry a protocol-correct assistant+tool pair.
  const second = seen[1];
  const asst = second.find((x) => x.role === 'assistant' && x.tool_calls);
  assert.ok(asst?.tool_calls, 'assistant message must carry tool_calls');
  assert.equal(asst.tool_calls[0].id, 'tc1');
  assert.equal(asst.tool_calls[0].type, 'function');
  assert.equal(asst.tool_calls[0].function.name, 'ReadProgram');
  const toolMsg = second.find((x) => x.role === 'tool');
  assert.equal(
    toolMsg?.tool_call_id,
    'tc1',
    'tool message must carry tool_call_id matching the assistant tool_call',
  );
});

test('R6-F1: a CLEAN final answer that overshoots the ledger returns ok (work done — no budget-exhausted)', async () => {
  // Single clean response (no tool calls) that alone costs more than the whole
  // budget. The task completed; there is nothing to extend, so the executor
  // returns ok and the overage is the documented soft-cap overshoot — NOT a
  // budget-exhausted that would trigger a pointless extend-or-stop clarify.
  const llm = scriptedLlm([
    {
      content: 'Final analysis: complete.',
      usage: {
        promptTokens: 150000,
        completionTokens: 200,
        totalTokens: 150200,
      },
    },
  ]);
  const m = mcp({});
  const { rag, writes } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  const res = await exec.execute({
    prompt: 'analyse',
    tools: [],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({}) as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.equal(
    res.status,
    'ok',
    'completed answer returns ok even though its call exceeded the budget',
  );
  assert.ok(
    writes.some((w) => w.content.includes('Final analysis')),
    'the answer was written to knowledge-RAG',
  );
});

test('emits mcp-call / mcp-result / tokens-used progress with identity.stepperId as source', async () => {
  const llm = scriptedLlm([
    { content: 'r', toolCalls: [{ name: 'ReadProgram', arguments: {} }] },
    { content: 'done' },
  ]);
  const m = mcp({ ReadProgram: 'src' });
  const { rag } = knowledgeStub();
  const events: StreamChunk[] = [];
  const onProgress: OnPartial = (e) => events.push(e);
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  await exec.execute({
    prompt: 'read',
    tools: [],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({
      ReadProgram: { name: 'ReadProgram', readOnly: true },
    }) as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    onProgress,
    ...META_BASE,
  });
  const mcpCall = events.find((e) => e.kind === 'mcp-call');
  assert.ok(
    mcpCall &&
      mcpCall.kind === 'mcp-call' &&
      mcpCall.source.stepperId === 'n1' &&
      mcpCall.tool === 'ReadProgram',
  );
});

// ── FIX A: proactive tool seeding tests ──────────────────────────────────────

test('FIX-A.1: capable model that never says "I can\'t" still calls MCP when tools are seeded from toolsRag', async () => {
  // LLM immediately emits a tool call on turn 1 — never requests more tools.
  // This proves the tool was available from the start (seeded proactively).
  const capturedToolArgs: { name: string; tools: string[] }[] = [];
  const llm = {
    name: 'stub',
    async chat(_messages: unknown, tools: { name: string }[]) {
      const idx = capturedToolArgs.length;
      capturedToolArgs.push({
        name: `call-${idx}`,
        tools: tools.map((t) => t.name),
      });
      if (idx === 0) {
        // First call: emit tool call immediately (model already sees ReadProgram)
        return {
          ok: true as const,
          value: {
            content: '',
            toolCalls: [{ name: 'ReadProgram', arguments: { p: 'Z' } }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
        };
      }
      // Second call: final answer
      return {
        ok: true as const,
        value: {
          content: 'Analysis complete.',
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        },
      };
    },
  };

  const m = mcp({ ReadProgram: 'REPORT z.' });
  const { rag, writes } = knowledgeStub();

  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });

  const res = await exec.execute({
    prompt: 'analyse program Z',
    tools: [], // empty — dispatcher sent no tools
    knowledgeRag: rag as never,
    toolsRag: toolsStub({
      ReadProgram: { name: 'ReadProgram', readOnly: true },
    }) as never,
    needResolver: new RegexNeedResolver(),
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });

  assert.equal(res.status, 'ok', 'executor returns ok');
  // The MCP call happened — model received the tool from seeding
  assert.deepEqual(m.calls, ['ReadProgram'], 'MCP was called');
  // The first LLM call had ReadProgram in its tools (seeded proactively)
  assert.ok(
    capturedToolArgs[0].tools.includes('ReadProgram'),
    `first LLM call must include ReadProgram; got: ${capturedToolArgs[0].tools.join(',')}`,
  );
  // Final answer was written to knowledge-RAG
  assert.ok(
    writes.some((w) => w.content.includes('Analysis complete')),
    'final answer written',
  );
});

test('FIX-A.2: empty toolsRag + no need signal does not crash — returns LLM answer', async () => {
  // toolsRag.query returns [] → tools remains empty → model returns generic answer
  const llm = scriptedLlm([{ content: 'Generic answer.' }]);
  const m = mcp({});
  const { rag } = knowledgeStub();

  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });

  const res = await exec.execute({
    prompt: 'do something',
    tools: [],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({}) as never, // empty toolsRag
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });

  assert.equal(res.status, 'ok', 'no crash when toolsRag is empty');
  assert.deepEqual(m.calls, [], 'no MCP calls made');
});

test('FIX-A.3: reactive injection deduplicates tools already seeded proactively', async () => {
  // Scenario: ReadProgram is seeded proactively; then the model says "I can't"
  // and the need resolver also fetches ReadProgram. It must not be duplicated.
  const toolsInSecondCall: string[] = [];
  let callCount = 0;
  const llm = {
    name: 'stub',
    async chat(_messages: unknown, tools: { name: string }[]) {
      callCount++;
      if (callCount === 1) {
        // Say "I can't" to trigger reactive injection
        return {
          ok: true as const,
          value: {
            content: "I can't read the program",
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          },
        };
      }
      if (callCount === 2) {
        toolsInSecondCall.push(...tools.map((t) => t.name));
        // Emit tool call
        return {
          ok: true as const,
          value: {
            content: '',
            toolCalls: [{ name: 'ReadProgram', arguments: {} }],
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          },
        };
      }
      return {
        ok: true as const,
        value: {
          content: 'done',
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        },
      };
    },
  };

  const m = mcp({ ReadProgram: 'src' });
  const { rag } = knowledgeStub();

  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });

  await exec.execute({
    prompt: 'read Z',
    tools: [],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({
      ReadProgram: { name: 'ReadProgram', readOnly: true },
    }) as never,
    needResolver: new RegexNeedResolver(),
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });

  // ReadProgram must appear exactly once in the second LLM call's tools
  const readProgramCount = toolsInSecondCall.filter(
    (n) => n === 'ReadProgram',
  ).length;
  assert.equal(
    readProgramCount,
    1,
    `ReadProgram must appear exactly once (no duplicate); got ${readProgramCount}`,
  );
});
