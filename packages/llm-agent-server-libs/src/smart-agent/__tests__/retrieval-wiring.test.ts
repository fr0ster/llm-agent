import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  DecisionRequest,
  IEmbedder,
  ILlm,
  IMcpClient,
  IProbabilityDecision,
  IRag,
  IRagRegistry,
  IReranker,
  LlmTool,
  RagResult,
} from '@mcp-abap-adt/llm-agent';
import {
  emptyLoadedPlugins,
  hasRetrievalStrategy,
  NoopRequestLogger,
  PASSAGE_QUESTION,
  TOOL_QUESTION,
} from '@mcp-abap-adt/llm-agent-libs';
import { InMemoryRag, SimpleRagRegistry } from '@mcp-abap-adt/llm-agent-rag';
import { parse } from 'yaml';
import { resolveSmartServerConfig } from '../config.js';
import {
  type BuildAgentDeps,
  buildAgent,
  SmartServer,
  type SmartServerConfig,
} from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

// `rag:` is required: SmartServer builds the tools/history stores through the
// makeRag seam only when `cfg.rag` is set (smart-server.ts, `if (this.cfg.rag)`).
const BASE_YAML = `
llm:
  provider: openai
  model: gpt-4o
rag:
  store:
    type: in-memory
`;
const DECISION = `decision:
  provider: typesafe
`;
const TOOLS_DECISION_YAML = `${BASE_YAML}  retrieval:
    tools:
      strategy: rerank
      reranker: decision
${DECISION}`;
const QUERY = 'find the passage';
const stubEmbedder = {
  embed: async () => ({ vector: [1, 0] }),
} as unknown as IEmbedder;

/** The passages the reranker was asked about, in question order. */
function passagesOf(req: DecisionRequest): unknown[] {
  return Object.values(req.questions).map((q) =>
    q.type === 'noul' && q.instructions && typeof q.instructions === 'object'
      ? (q.instructions as { passage?: unknown }).passage
      : undefined,
  );
}

/** The task wording of every question of one request. */
function tasksOf(req: DecisionRequest): unknown[] {
  return Object.values(req.questions).map((q) =>
    q.type === 'noul' && q.instructions && typeof q.instructions === 'object'
      ? (q.instructions as { task?: unknown }).task
      : undefined,
  );
}

const TOOL_HITS: RagResult[] = [
  { text: 'tool passage one', metadata: { id: '1' }, score: 0.5 },
  { text: 'tool passage two', metadata: { id: '2' }, score: 0.4 },
];
const HISTORY_HITS: RagResult[] = [
  { text: 'history passage one', metadata: { id: 'h1' }, score: 0.5 },
  { text: 'history passage two', metadata: { id: 'h2' }, score: 0.4 },
];

/**
 * A makeRag whose stores answer with fixed hits: the first store the server
 * builds is `tools`, the second `history` (smart-server.ts, `_buildInfra`);
 * any later store (a worker's) answers with `toolHits`. `queried` counts the
 * queries each store received.
 */
function labelledStores(toolHits: RagResult[] = TOOL_HITS) {
  let n = 0;
  const queried: Record<string, number> = {};
  const makeRag: BuildAgentDeps['makeRag'] = async (input) => {
    const rag = (await constructionSeams.makeRag(input)) as IRag;
    const i = n++;
    const label = i === 0 ? 'tools' : i === 1 ? 'history' : `store${i}`;
    const hits = label === 'history' ? HISTORY_HITS : toolHits;
    rag.query = async () => {
      queried[label] = (queried[label] ?? 0) + 1;
      return { ok: true, value: [...hits] };
    };
    return rag;
  };
  return { makeRag, queried };
}

function recordingModel(score?: (passage: unknown) => number) {
  const seen: Array<{ req: DecisionRequest; options?: CallOptions }> = [];
  const model: IProbabilityDecision = {
    decide: async (req, options) => {
      seen.push({ req, options });
      const answers: Record<string, { type: 'noul'; probability: number }> = {};
      Object.entries(req.questions).forEach(([k, q], i) => {
        const passage =
          q.type === 'noul' &&
          q.instructions &&
          typeof q.instructions === 'object'
            ? (q.instructions as { passage?: unknown }).passage
            : undefined;
        answers[k] = {
          type: 'noul',
          probability: score ? score(passage) : 1 - i * 0.1,
        };
      });
      return { ok: true, value: { model: 'fake', answers } };
    },
  };
  return { model, seen };
}

/** Loads nothing, so the host's default plugin directories cannot leak in. */
const noPlugins = { load: async () => emptyLoadedPlugins() };

function configFrom(text: string): SmartServerConfig {
  return {
    ...resolveSmartServerConfig(
      {},
      parse(text),
      {},
      {
        skipProviderRuntimeChecks: true,
      },
    ),
    port: 0,
    skipModelValidation: true,
  } as SmartServerConfig;
}

function post(port: number, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

async function chatOnce(
  server: SmartServer,
  content = QUERY,
  afterStart?: () => void,
): Promise<void> {
  const handle = await server.start();
  try {
    afterStart?.();
    const status = await post(handle.port, '/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content }],
    });
    assert.equal(status, 200);
  } finally {
    await handle.close();
  }
}

const NOTES_HITS: RagResult[] = [
  { text: 'notes passage one', metadata: { id: 'n1' }, score: 0.5 },
  { text: 'notes passage two', metadata: { id: 'n2' }, score: 0.4 },
];

/**
 * A global collection `notes` added to the deployment registry after startup,
 * so every session registry copies it (buildSessionRagRegistry) and the flat
 * pipeline queries it as a custom store. Session agents get no `history`
 * stage (`partsToBaseInput` passes no historyRag), so a collection is the
 * store a request can actually reach besides `tools`.
 */
function notesCollection(server: SmartServer) {
  const counter = { queried: 0 };
  const rag = new InMemoryRag();
  rag.query = async () => {
    counter.queried++;
    return { ok: true, value: [...NOTES_HITS] };
  };
  const register = () => {
    const registry = (server as unknown as { _globalRagRegistry: IRagRegistry })
      ._globalRagRegistry;
    registry.register('notes', rag, undefined, {
      displayName: 'notes',
      scope: 'global',
    });
  };
  return { register, counter };
}

/** Registers `reranker` as a plugin through a temp module (`plugins: [...]`). */
function pluginModule(reranker: IReranker): {
  path: string;
  dispose: () => void;
} {
  // An absolute path: smart-server resolves `plugins: [...]` specifiers as
  // './' (cwd-relative), '/' (absolute) or a package name. The module's
  // `reranker` export is what mergePluginExports picks up (plugins/types.ts).
  const dir = mkdtempSync(join(tmpdir(), 'rr-plugin-'));
  const path = join(dir, 'reranker-plugin.mjs');
  writeFileSync(
    path,
    'export const reranker = globalThis.__retrievalWiringPlugin;\n',
  );
  (globalThis as Record<string, unknown>).__retrievalWiringPlugin = reranker;
  return {
    path,
    dispose: () => {
      delete (globalThis as Record<string, unknown>).__retrievalWiringPlugin;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A controller pipeline (config from build-agent-deps.test.ts) whose every LLM
 * answers a one-step plan, so the step's `selectTools` runs with STEP as its
 * query. `stepCall()` returns the decision call made for that step.
 */
function controllerSetup() {
  const STEP = 'read the table definition';
  const llm = {
    model: 'stub',
    chat: async () => ({
      ok: true,
      value: {
        content: JSON.stringify({ plan: [{ name: 's1', instructions: STEP }] }),
        toolCalls: [],
      },
    }),
    streamChat: async function* () {},
  } as unknown as ILlm;
  const { model, seen } = recordingModel();
  const { makeRag } = labelledStores();
  const yaml = `${TOOLS_DECISION_YAML}pipeline:
  name: controller
  config:
    subagents:
      evaluator: {}
      planner: {}
      executor: {}
`;
  return {
    cfg: { ...configFrom(yaml), pluginLoader: noPlugins } as SmartServerConfig,
    deps: {
      ...constructionSeams,
      makeLlm: async () => llm,
      makeRag,
      embedder: stubEmbedder,
      makeDecisionModel: async () => model,
    } as BuildAgentDeps,
    stepCall: () => {
      const step = seen.find((s) => s.req.state === STEP);
      assert.ok(
        step,
        `the step's selectTools must reach the decision model; saw states ${JSON.stringify(seen.map((s) => s.req.state))}`,
      );
      return step;
    },
  };
}

describe('retrieval strategy wiring (§13.4)', () => {
  it('HTTP: rag.retrieval.tools (decision) reranks a session request with the tool question', async () => {
    const { model, seen } = recordingModel();
    const { makeRag } = labelledStores();
    const server = new SmartServer(
      { ...configFrom(TOOLS_DECISION_YAML), pluginLoader: noPlugins },
      {
        ...constructionSeams,
        makeRag,
        embedder: stubEmbedder,
        makeDecisionModel: async () => model,
      },
    );
    await chatOnce(server);
    // Wrapped at creation AND passed to withRetrievalStrategy: the projection
    // sees the brand, so the one tools query is reranked exactly once.
    assert.equal(seen.length, 1, 'exactly one rerank for the one tools query');
    assert.equal(seen[0].req.state, QUERY);
    assert.deepEqual(
      passagesOf(seen[0].req),
      TOOL_HITS.map((h) => h.text),
    );
    assert.ok(tasksOf(seen[0].req).every((t) => t === TOOL_QUESTION.task));
  });

  it('embedded buildAgent(): the same YAML reranks with the tool question', async () => {
    const { model, seen } = recordingModel();
    const { makeRag } = labelledStores();
    const { agent, close } = await buildAgent(
      { ...configFrom(TOOLS_DECISION_YAML), pluginLoader: noPlugins },
      {
        ...constructionSeams,
        makeRag,
        embedder: stubEmbedder,
        makeDecisionModel: async () => model,
      },
    );
    try {
      await agent.process(QUERY);
      assert.ok(seen.length >= 1, 'the embedded agent must rerank tools');
      assert.equal(seen[0].req.state, QUERY);
      assert.deepEqual(
        passagesOf(seen[0].req),
        TOOL_HITS.map((h) => h.text),
      );
      assert.ok(tasksOf(seen[0].req).every((t) => t === TOOL_QUESTION.task));
    } finally {
      await close();
    }
  });

  it('controller per-step selectTools (HTTP) goes through the tools strategy with the request loggers', async () => {
    const c = controllerSetup();
    const server = new SmartServer(c.cfg, c.deps);
    await chatOnce(server, 'do a task');
    const step = c.stepCall();
    assert.ok(tasksOf(step.req).every((t) => t === TOOL_QUESTION.task));
    assert.ok(step.options?.requestLogger, 'requestLogger must reach it');
    assert.ok(step.options?.sessionLogger, 'sessionLogger must reach it');
    // The HTTP route creates no AbortSignal of its own (chat-route-handler
    // passes none; SmartAgent adds one only for agent.timeoutMs), so the
    // caller's signal is pinned on the embedded path below.
  });

  it("controller per-step selectTools (embedded) forwards the caller's signal to the reranker", async () => {
    const c = controllerSetup();
    const { agent, close } = await buildAgent(c.cfg, c.deps);
    const ctrl = new AbortController();
    try {
      await agent.process('do a task', { signal: ctrl.signal });
    } finally {
      await close();
    }
    const step = c.stepCall();
    assert.ok(step.options?.signal, 'signal must reach the reranker');
    assert.equal(step.options?.signal, ctrl.signal);
    assert.ok(step.options?.requestLogger, 'requestLogger must reach it');
  });

  it('precedence: an explicit embedding store is never reranked by the plugin; an unlisted store still is', async () => {
    const calls: string[][] = [];
    const plugin = pluginModule({
      rerank: async (_query, r) => {
        calls.push(r.map((x) => x.text));
        return { ok: true, value: r };
      },
    });
    const { makeRag } = labelledStores();
    const yaml = `${BASE_YAML}  retrieval:
    history:
      strategy: embedding
    notes:
      strategy: embedding
`;
    const server = new SmartServer(
      {
        ...configFrom(yaml),
        pluginLoader: noPlugins,
        plugins: [plugin.path],
      } as SmartServerConfig,
      { ...constructionSeams, makeRag, embedder: stubEmbedder },
    );
    const notes = notesCollection(server);
    try {
      await chatOnce(server, QUERY, notes.register);
      // The server-built history store carries its explicit strategy, so the
      // rerank stage skips it wherever it is read (hasRetrievalStrategy).
      const history = (
        server as unknown as { _globalRagRegistry: IRagRegistry }
      )._globalRagRegistry.get('history', 'global');
      assert.ok(history, 'the history store is registered');
      assert.ok(
        hasRetrievalStrategy(history),
        'history: { strategy: embedding } must brand the server-built store',
      );
    } finally {
      plugin.dispose();
    }
    assert.ok(notes.counter.queried >= 1, 'notes must be queried');
    const texts = calls.flat();
    for (const h of NOTES_HITS) {
      assert.ok(
        !texts.includes(h.text),
        `an explicit embedding store was sent to the plugin reranker: ${JSON.stringify(calls)}`,
      );
    }
    assert.ok(
      TOOL_HITS.every((h) => texts.includes(h.text)),
      `the unlisted tools store must still be reranked by the plugin: ${JSON.stringify(calls)}`,
    );
  });

  it('agent.toolSelection reaches a session agent and filters the reranked scores', async () => {
    const tools: LlmTool[] = ['Alpha', 'Beta', 'Gamma'].map((name) => ({
      name,
      description: `${name} tool`,
      inputSchema: { type: 'object', properties: {} },
    }));
    const hits: RagResult[] = tools.map((t, i) => ({
      text: `Tool: ${t.name} — ${t.description}`,
      metadata: { id: `tool:${t.name}` },
      score: 0.9 - i * 0.1,
    }));
    const mcp = {
      listTools: async () => ({ ok: true, value: tools }),
      callTool: async () => ({ ok: true, value: { content: 'ok' } }),
    } as unknown as IMcpClient;
    const offered: string[][] = [];
    const llm = {
      model: 'stub',
      chat: async (_m: unknown, t?: LlmTool[]) => {
        offered.push((t ?? []).map((x) => x.name));
        return { ok: true, value: { content: 'ok', toolCalls: [] } };
      },
      streamChat: async function* (_m: unknown, t?: LlmTool[]) {
        offered.push((t ?? []).map((x) => x.name));
        yield { ok: true, value: { content: 'ok', finishReason: 'stop' } };
      },
    } as unknown as ILlm;
    const { model } = recordingModel((p) =>
      typeof p === 'string' && p.includes('Alpha') ? 0.9 : 0.1,
    );
    const { makeRag } = labelledStores(hits);
    const yaml = `${TOOLS_DECISION_YAML}agent:
  toolSelection:
    strategy: threshold
    minScore: 0.5
`;
    const server = new SmartServer(
      { ...configFrom(yaml), pluginLoader: noPlugins },
      {
        ...constructionSeams,
        makeLlm: async () => llm,
        makeRag,
        embedder: stubEmbedder,
        mcpClients: [mcp],
        makeDecisionModel: async () => model,
      },
    );
    await chatOnce(server, 'use alpha');
    const withTools = offered.filter((o) => o.length > 0);
    assert.ok(
      withTools.length >= 1,
      `no LLM call offered tools: ${JSON.stringify(offered)}`,
    );
    for (const o of withTools) {
      assert.deepEqual(o, ['Alpha'], `offered ${JSON.stringify(offered)}`);
    }
  });

  it('a store with no rag.retrieval entry stays on embedding', async () => {
    const { model, seen } = recordingModel();
    const { makeRag } = labelledStores();
    const server = new SmartServer(
      { ...configFrom(TOOLS_DECISION_YAML), pluginLoader: noPlugins },
      {
        ...constructionSeams,
        makeRag,
        embedder: stubEmbedder,
        makeDecisionModel: async () => model,
      },
    );
    const notes = notesCollection(server);
    await chatOnce(server, QUERY, notes.register);
    assert.ok(notes.counter.queried >= 1, 'notes must be queried');
    assert.ok(seen.length >= 1, 'tools (listed) must be reranked');
    for (const s of seen) {
      for (const p of passagesOf(s.req)) {
        assert.ok(
          !NOTES_HITS.some((h) => h.text === p),
          'notes (not listed) must never reach the decision model',
        );
      }
      assert.ok(
        tasksOf(s.req).every((t) => t !== PASSAGE_QUESTION.task),
        'only the tools question is asked',
      );
    }
  });

  it("worker stores follow the main config's map by key", async () => {
    const { model, seen } = recordingModel();
    const { makeRag, queried } = labelledStores();
    const WORKER_QUERY = 'worker query';
    const cfg = {
      ...configFrom(TOOLS_DECISION_YAML),
      pluginLoader: noPlugins,
      subAgentConfigs: [
        {
          name: 'worker',
          config: {
            skipModelValidation: true,
            rag: { store: { type: 'in-memory' } },
          },
        },
      ],
    } as unknown as SmartServerConfig;
    const server = new SmartServer(cfg, {
      ...constructionSeams,
      makeRag,
      embedder: stubEmbedder,
      makeDecisionModel: async () => model,
    });
    const built = await server._buildEmbeddedAgent();
    try {
      // White-box: the worker agent as the registry builds it (cached stores).
      const worker = await (
        server as unknown as {
          buildSubAgent: (
            name: string,
            subCfg: unknown,
            logger: unknown,
            factories: Record<string, unknown>,
          ) => Promise<{ process: (q: string) => Promise<unknown> }>;
        }
      ).buildSubAgent(
        'worker',
        cfg.subAgentConfigs?.[0]?.config,
        { log: () => {} },
        {},
      );
      await worker.process(WORKER_QUERY);
      const workerStores = Object.keys(queried).filter((k) =>
        k.startsWith('store'),
      );
      assert.ok(
        workerStores.length >= 1,
        `the worker's own stores must be queried; saw ${JSON.stringify(queried)}`,
      );
      const hit = seen.find((s) => s.req.state === WORKER_QUERY);
      assert.ok(
        hit,
        `the worker's tools store must go through the main tools strategy; saw ${JSON.stringify(seen.map((s) => s.req.state))}`,
      );
      assert.ok(tasksOf(hit.req).every((t) => t === TOOL_QUESTION.task));
    } finally {
      await built.close();
    }
  });

  it('a worker sharing the parent registry reranks a named collection by the main map', async () => {
    const { model, seen } = recordingModel();
    const { makeRag } = labelledStores();
    const WORKER_QUERY = 'worker notes query';
    const yaml = `${BASE_YAML}  retrieval:
    notes:
      strategy: rerank
      reranker: decision
${DECISION}`;
    const cfg = {
      ...configFrom(yaml),
      pluginLoader: noPlugins,
      subAgentConfigs: [
        { name: 'worker', config: { skipModelValidation: true } },
      ],
    } as unknown as SmartServerConfig;
    const server = new SmartServer(cfg, {
      ...constructionSeams,
      makeRag,
      embedder: stubEmbedder,
      makeDecisionModel: async () => model,
    });
    const built = await server._buildEmbeddedAgent();
    try {
      const notes = new InMemoryRag();
      let notesQueried = 0;
      notes.query = async () => {
        notesQueried++;
        return { ok: true, value: [...NOTES_HITS] };
      };
      const registry = new SimpleRagRegistry();
      registry.register('notes', notes, undefined, {
        displayName: 'notes',
        scope: 'global',
      });
      // White-box: the per-session re-wire path (injected parent registry).
      const worker = await (
        server as unknown as {
          buildSubAgent: (
            name: string,
            subCfg: unknown,
            logger: unknown,
            factories: Record<string, unknown>,
            injected: unknown,
          ) => Promise<{ process: (q: string) => Promise<unknown> }>;
        }
      ).buildSubAgent(
        'worker',
        cfg.subAgentConfigs?.[0]?.config,
        { log: () => {} },
        {},
        {
          ragRegistry: registry,
          toolsRag: undefined,
          mcpClients: [],
          requestLogger: new NoopRequestLogger(),
          embedder: stubEmbedder,
        },
      );
      await worker.process(WORKER_QUERY);
      assert.ok(notesQueried >= 1, 'the worker must query notes');
      const hit = seen.find(
        (s) =>
          s.req.state === WORKER_QUERY &&
          passagesOf(s.req).includes(NOTES_HITS[0].text),
      );
      assert.ok(
        hit,
        `the worker's notes store must go through the main notes strategy; saw ${JSON.stringify(seen.map((s) => s.req.state))}`,
      );
      assert.ok(tasksOf(hit.req).every((t) => t === PASSAGE_QUESTION.task));
    } finally {
      await built.close();
    }
  });

  it('regression: a plugin reranker reaches the session agent', async () => {
    const calls: Array<{ query: string; texts: string[] }> = [];
    const plugin = pluginModule({
      rerank: async (query, r) => {
        calls.push({ query, texts: r.map((x) => x.text) });
        return { ok: true, value: r };
      },
    });
    const { makeRag } = labelledStores();
    const cfg = {
      ...configFrom(BASE_YAML),
      pluginLoader: noPlugins,
      plugins: [plugin.path],
    } as SmartServerConfig;
    const server = new SmartServer(cfg, {
      ...constructionSeams,
      makeRag,
      embedder: stubEmbedder,
    });
    try {
      await chatOnce(server);
    } finally {
      plugin.dispose();
    }
    assert.ok(
      calls.length >= 1,
      'a plugin reranker was a silent no-op on sessions',
    );
    assert.equal(calls[0].query, QUERY);
  });
});
