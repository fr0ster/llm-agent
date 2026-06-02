import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OnPartial, StreamChunk } from '@mcp-abap-adt/llm-agent';
import { TokenLedger } from '@mcp-abap-adt/llm-agent';
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

// (Removed H.5 / H.5b: the agent-side readOnly mutation gate was removed —
// tool permissioning is the MCP server's responsibility; whatever it exposes is
// allowed. There is no agent-side confirm/allowlist anymore.)

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

test('stuck need with no NEW tools → escalates to the consumer (ClarifySignal), bounded', async () => {
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
  // 18.1: after the no-progress cap (analyze → find tools → none new → retry,
  // exhausted) the executor escalates to the consumer instead of a silent
  // partial — it throws ClarifySignal (the handler turns it into a clarify).
  await assert.rejects(
    () =>
      exec.execute({
        prompt: 'do x',
        tools: [{ name: 'Foo' }], // Foo already present → re-query never adds anything new
        knowledgeRag: rag as never,
        toolsRag: toolsRag as never,
        budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
        ...META_BASE,
      }),
    (err: Error) =>
      err.name === 'ClarifySignal' && /could not complete/i.test(err.message),
  );
});

test('#Phase2: a repeated (tool,args) call is deduped — MCP hit once; different args still fetched', async () => {
  // O01 fetched, then O01 AGAIN (dedup → no 2nd MCP hit), then O02 (new args →
  // real fetch), then a final answer.
  const llm = scriptedLlm([
    {
      content: 'a',
      toolCalls: [{ name: 'GetInclude', arguments: { n: 'O01' } }],
    },
    {
      content: 'b',
      toolCalls: [{ name: 'GetInclude', arguments: { n: 'O01' } }],
    },
    {
      content: 'c',
      toolCalls: [{ name: 'GetInclude', arguments: { n: 'O02' } }],
    },
    { content: 'Final.' },
  ]);
  const m = mcp({ GetInclude: 'INCLUDE BODY' });
  const { rag, writes } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  const res = await exec.execute({
    prompt: 'read includes',
    tools: [{ name: 'GetInclude' }],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({ GetInclude: { name: 'GetInclude' } }) as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.equal(res.status, 'ok');
  // 2 distinct (tool,args) → exactly 2 MCP calls (the duplicate O01 was deduped).
  assert.deepEqual(m.calls, ['GetInclude', 'GetInclude']);
  // Only the 2 real fetches were written to the store (not the deduped repeat).
  assert.equal(writes.filter((w) => w.content === 'INCLUDE BODY').length, 2);
});

test('needs-driven search: a SEPARATE need-query unions in the need tool (prompt tool kept)', async () => {
  const llm = scriptedLlm([{ content: 'done' }]);
  const queries: string[] = [];
  const toolsRag = {
    async query(q: string) {
      queries.push(q);
      // prompt query → GetProgram (main); needs query → GetInclude (additive)
      return /include/i.test(q)
        ? [{ name: 'GetInclude' }]
        : [{ name: 'GetProgram' }];
    },
    lookup() {
      return undefined;
    },
  };
  let offered: Array<{ name: string }> = [];
  const llmCapture = {
    name: 'stub',
    async chat(_m: unknown, tools: Array<{ name: string }>) {
      if (offered.length === 0) offered = tools ?? [];
      return (llm as { chat: () => unknown }).chat();
    },
  };
  const { rag } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llmCapture as never,
    callMcp: mcp({}).call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  await exec.execute({
    prompt: 'review program Z',
    tools: [], // empty → executor seeds from toolsRag
    evaluatorNeeds: ['read the include bodies of the program'],
    knowledgeRag: rag as never,
    toolsRag: toolsRag as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  // TWO searches: the prompt seed + a SEPARATE query keyed on the needs.
  assert.ok(
    queries.some((q) => /read the include bodies/.test(q)),
    'a separate tool-search query must be keyed on the Evaluator needs',
  );
  const names = offered.map((t) => t.name);
  assert.ok(names.includes('GetProgram'), 'prompt tool kept (main program)');
  assert.ok(names.includes('GetInclude'), 'need tool unioned in (includes)');
});

test('#Phase2 cross-step: an artefact already in the session store is injected, not re-fetched', async () => {
  // The model calls GetInclude(O01); another step already stored it → the
  // executor injects the STORED content and does NOT hit MCP.
  const llm = scriptedLlm([
    {
      content: 'a',
      toolCalls: [{ name: 'GetInclude', arguments: { n: 'O01' } }],
    },
    { content: 'Final.' },
  ]);
  const m = mcp({ GetInclude: 'LIVE FETCH (should not happen)' });
  // knowledge stub that reports O01 already fetched, with stored content
  const stored = 'STORED O01 BODY';
  // artifactIdentityKey lowercases — the executor computes this for {n:'O01'}.
  const key = 'getinclude:{"n":"o01"}';
  const rag = {
    async query() {
      return [];
    },
    async list() {
      return [];
    },
    async write() {},
    fingerprint() {
      return 'n=0';
    },
    async hasArtifact(k: string) {
      return k === key;
    },
    async getArtifact(k: string) {
      return k === key ? stored : undefined;
    },
  };
  let sawStored = false;
  const exec = new CyclicReActExecutor({
    llm: {
      name: 'stub',
      async chat(msgs: Array<{ role: string; content: string }>) {
        if (msgs.some((mm) => mm.role === 'tool' && mm.content === stored))
          sawStored = true;
        return (llm as { chat: () => unknown }).chat();
      },
    } as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  const res = await exec.execute({
    prompt: 'analyze include O01',
    tools: [{ name: 'GetInclude' }],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({ GetInclude: { name: 'GetInclude' } }) as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.equal(res.status, 'ok');
  assert.deepEqual(m.calls, [], 'MCP must NOT be hit — stored content reused');
  assert.ok(
    sawStored,
    'the stored artefact content was injected as the tool result',
  );
});

test('maxNoProgressNeeds is configurable (escalates after the given cap)', async () => {
  const llm = scriptedLlm([
    { content: 'need' },
    { content: 'need' },
    { content: 'need' },
    { content: 'need' },
  ]);
  const { rag } = knowledgeStub();
  const toolsRag = toolsByQuery(() => [{ name: 'Foo' }], {
    Foo: { name: 'Foo' },
  });
  const resolver = fakeResolver([{ queryToolsRag: 'foo' }]);
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: mcp({}).call,
    component: 'tool-loop',
    maxIterations: 10,
    needResolver: resolver as never,
    maxNoProgressNeeds: 3,
  });
  await assert.rejects(
    () =>
      exec.execute({
        prompt: 'do x',
        tools: [{ name: 'Foo' }],
        knowledgeRag: rag as never,
        toolsRag: toolsRag as never,
        budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
        ...META_BASE,
      }),
    /ClarifySignal/,
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
          content: 'Read an include body via GetInclude.',
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
    'the seeded blackboard guidance must appear in the executor LLM prompt',
  );
});

test('PRIORITY: a tool named in a RAG seed beats what bare-prompt MCP search returns', async () => {
  // The real scenario. MCP tool-search (MCP_RAG) for "review program Z" surfaces
  // only GetProgram. A seeded fact says include bodies are read via GetInclude.
  // Because the executor enriches the tool-search query with that seeded fact
  // BEFORE vectorizing, GetInclude surfaces and is offered to the model — i.e.
  // the RAG-seeded tool takes PRIORITY over the bare-prompt MCP result. This is
  // exactly what made includes readable on live SAP.
  const toolsRag = {
    async query(text: string) {
      // Seed-steered query (carries the GetInclude guidance) → include tool.
      // Bare-prompt query → only the program tool MCP_RAG ranks for "review".
      return /GetInclude/.test(text)
        ? [{ name: 'GetInclude', readOnly: true }]
        : [{ name: 'GetProgram', readOnly: true }];
    },
    lookup(n: string) {
      return { name: n, readOnly: true };
    },
  };
  const ragWithGuidance = {
    async query() {
      return [
        {
          content: 'Read an include body via GetInclude (GetProgram cannot).',
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
  // Capture the tool set the executor offers the model on turn 1.
  let offeredTools: string[] = [];
  const llm = {
    name: 'stub',
    async chat(_m: unknown, tools: Array<{ name: string }>) {
      offeredTools = tools.map((t) => t.name);
      return {
        ok: true as const,
        value: {
          content: 'Done.',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      };
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
    tools: [], // empty → triggers proactive seeding (the path under test)
    knowledgeRag: ragWithGuidance as never,
    toolsRag: toolsRag as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.ok(
    offeredTools.includes('GetInclude'),
    `seeded tool must take priority and be offered; got: ${offeredTools.join(',') || '(none)'}`,
  );
});

test('executor sends a task-agnostic system prompt (tool-use protocol) so unmet needs get voiced', async () => {
  let firstSystem = '';
  const llm = {
    name: 'stub',
    async chat(messages: Array<{ role: string; content: string }>) {
      if (!firstSystem) {
        const s = messages.find((m) => m.role === 'system');
        firstSystem = s?.content ?? '';
      }
      return {
        ok: true as const,
        value: {
          content: 'done',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      };
    },
  };
  const { rag } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: mcp({}).call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  await exec.execute({
    prompt: 'do the task',
    tools: [{ name: 'seed' }],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({}) as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.ok(firstSystem.length > 0, 'a system message must be sent');
  // Generic tool-use protocol — must NOT bind to a task type or a tool name.
  assert.match(
    firstSystem,
    /do NOT guess|state .*the capability you still need/i,
  );
  assert.doesNotMatch(
    firstSystem,
    /\b(ABAP|include|GetInclude|GetProgram|review|analy)/i,
    'system prompt must stay task-agnostic (no domain/task/tool binding)',
  );
});

test('a consumer systemPrompt override replaces the default EXECUTOR_SYSTEM', async () => {
  let firstSystem = '';
  const llm = {
    name: 'stub',
    async chat(messages: Array<{ role: string; content: string }>) {
      if (!firstSystem)
        firstSystem = messages.find((m) => m.role === 'system')?.content ?? '';
      return {
        ok: true as const,
        value: {
          content: 'done',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      };
    },
  };
  const { rag } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: mcp({}).call,
    component: 'tool-loop',
    maxIterations: 10,
    systemPrompt: 'CONSUMER PROMPT: always read all includes first.',
  });
  await exec.execute({
    prompt: 'do the task',
    tools: [{ name: 'seed' }],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({}) as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.match(
    firstSystem,
    /CONSUMER PROMPT: always read all includes first\./,
  );
  // The default protocol text must be gone — the override fully replaces it.
  assert.doesNotMatch(firstSystem, /state in ONE sentence the capability/i);
});

test('#167: client externalTools are MERGED with seeded MCP tools and offered to the model', async () => {
  let firstTools: Array<{ name: string }> = [];
  const llm = {
    name: 'stub',
    async chat(_messages: unknown, tools: Array<{ name: string }>) {
      if (firstTools.length === 0) firstTools = tools ?? [];
      return {
        ok: true as const,
        value: {
          content: 'done',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      };
    },
  };
  const { rag } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: mcp({}).call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  await exec.execute({
    prompt: 'review and save a file',
    tools: [], // no dispatcher tools → executor seeds MCP from toolsRag
    externalTools: [{ name: 'create_file' }] as never,
    knowledgeRag: rag as never,
    // toolsRag seeds an MCP tool so we can assert BOTH are present (merge, not replace)
    toolsRag: toolsStub({ GetProgram: { name: 'GetProgram' } }) as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  const names = firstTools.map((t) => t.name);
  assert.ok(names.includes('create_file'), 'external tool must be offered');
  assert.ok(
    names.includes('GetProgram'),
    'seeded MCP tool must still be offered (merge, not replace)',
  );
});

test('scenario: a multi-fetch sequence writes a SEPARATE knowledge-RAG artifact per tool result', async () => {
  // Mirrors the real review shape (read object → list parts → read each part)
  // with neutral tool names: every tool RESULT must be persisted as its own
  // mcp-result artifact so the finalizer can synthesize from all of them.
  const llm = scriptedLlm([
    {
      content: 'a',
      toolCalls: [{ name: 'ReadObject', arguments: { n: 'Z' } }],
    },
    { content: 'b', toolCalls: [{ name: 'ListParts', arguments: { n: 'Z' } }] },
    {
      content: 'c',
      toolCalls: [{ name: 'ReadPart', arguments: { p: 'Z_A' } }],
    },
    {
      content: 'd',
      toolCalls: [{ name: 'ReadPart', arguments: { p: 'Z_B' } }],
    },
    { content: 'Final review of Z.' },
  ]);
  const m = mcp({
    ReadObject: 'OBJECT-SOURCE',
    ListParts: 'Z_A\nZ_B',
    ReadPart: 'PART-SOURCE',
  });
  const { rag, writes } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  await exec.execute({
    prompt: 'review Z fully',
    tools: [],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({
      ReadObject: { name: 'ReadObject', readOnly: true },
      ListParts: { name: 'ListParts', readOnly: true },
      ReadPart: { name: 'ReadPart', readOnly: true },
    }) as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.deepEqual(m.calls, [
    'ReadObject',
    'ListParts',
    'ReadPart',
    'ReadPart',
  ]);
  const artifacts = writes.filter((w) => w.artifactType === 'mcp-result');
  assert.equal(
    artifacts.length,
    4,
    'one mcp-result artifact per tool call (object + list + 2 parts)',
  );
  assert.ok(
    writes.some((w) => w.content.includes('Final review of Z')),
    'final answer also persisted',
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

// A sessionLogger that captures every logStep call for assertions.
function loggerStub() {
  const steps: { name: string; data: unknown }[] = [];
  return {
    steps,
    logger: {
      logStep: (name: string, data: unknown) => steps.push({ name, data }),
    },
  };
}

test('Guard 2b: established need + empty toolset → explicit ClarifySignal, no LLM answer', async () => {
  // The Evaluator named a need (evaluatorNeeds) but toolsRag returns nothing →
  // there is no tool to satisfy it. The executor must refuse to invent an answer:
  // throw ClarifySignal, make zero MCP calls, and log executor_no_tools.
  const llm = scriptedLlm([{ content: 'A fabricated answer.' }]);
  const m = mcp({});
  const { rag } = knowledgeStub();
  const { steps, logger } = loggerStub();

  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });

  await assert.rejects(
    () =>
      exec.execute({
        prompt: 'review the program including its includes',
        tools: [],
        evaluatorNeeds: ['read the include bodies of the program'],
        knowledgeRag: rag as never,
        toolsRag: toolsStub({}) as never, // empty → cannot satisfy the need
        sessionLogger: logger as never,
        budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
        ...META_BASE,
      }),
    /no tool is available|empty set/,
    'must throw ClarifySignal instead of answering',
  );
  assert.deepEqual(m.calls, [], 'no MCP calls when toolset is empty');
  assert.ok(
    steps.some((s) => s.name === 'executor_no_tools'),
    'logs executor_no_tools',
  );
});

test('Guard 2b: established need but allowToolless → no error (escape hatch)', async () => {
  const llm = scriptedLlm([{ content: 'Reasoned answer.' }]);
  const m = mcp({});
  const { rag } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
    allowToolless: true,
  });
  const res = await exec.execute({
    prompt: 'reason about X',
    tools: [],
    evaluatorNeeds: ['some need'],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({}) as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });
  assert.equal(res.status, 'ok', 'allowToolless lets a tool-free step answer');
});

test('Guard 1: tools offered but final answer made with no tool calls/facts → hallucination_suspected', async () => {
  // toolsRag seeds a tool (tools.length>0), no facts in the store, and the model
  // answers immediately without calling anything → ungrounded answer signature.
  // Status stays ok (not a hard fail) but a token-backed signal is logged.
  const llm = scriptedLlm([
    {
      content: 'An answer with no grounding.',
      usage: { promptTokens: 42, completionTokens: 10, totalTokens: 52 },
    },
  ]);
  const m = mcp({});
  const { rag } = knowledgeStub();
  const { steps, logger } = loggerStub();

  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });

  const res = await exec.execute({
    prompt: 'analyze something',
    tools: [],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({ Foo: { name: 'Foo' } }) as never, // seeds → tools.length>0
    sessionLogger: logger as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });

  assert.equal(
    res.status,
    'ok',
    'detector does not hard-fail a tool-free answer',
  );
  const flag = steps.find((s) => s.name === 'hallucination_suspected');
  assert.ok(flag, 'emits hallucination_suspected');
  assert.equal(
    (flag?.data as { finalPromptTokens: number }).finalPromptTokens,
    42,
    'records the answer-producing call prompt tokens as evidence',
  );
});

test('Guard 1: a tool WAS called → no hallucination flag', async () => {
  const llm = scriptedLlm([
    { content: '', toolCalls: [{ name: 'Foo', arguments: {} }] },
    { content: 'Grounded answer.' },
  ]);
  const m = mcp({ Foo: 'data' });
  const { rag } = knowledgeStub();
  const { steps, logger } = loggerStub();

  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });

  const res = await exec.execute({
    prompt: 'analyze something',
    tools: [],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({ Foo: { name: 'Foo' } }) as never,
    sessionLogger: logger as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
    ...META_BASE,
  });

  assert.equal(res.status, 'ok');
  assert.ok(
    !steps.some((s) => s.name === 'hallucination_suspected'),
    'no flag when a tool was actually called',
  );
});
