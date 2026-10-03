import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type {
  DecisionRequest,
  IDecisionModel,
  IEmbedder,
  IRag,
  IReranker,
  RagResult,
} from '@mcp-abap-adt/llm-agent';
import { emptyLoadedPlugins } from '@mcp-abap-adt/llm-agent-libs';
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
// makeRag seam only when `cfg.rag` is set (smart-server.ts, `if (this.cfg.rag)`),
// and without a store the rerank stage never runs.
const BASE_YAML = `
llm:
  provider: openai
  model: gpt-4o
rag:
  store:
    type: in-memory
`;
const YAML = `${BASE_YAML}decision:
  provider: typesafe
reranker:
  type: decision
`;
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

const HITS: RagResult[] = [
  { text: 'passage one', metadata: { id: '1' }, score: 0.5 },
  { text: 'passage two', metadata: { id: '2' }, score: 0.4 },
];

/** Every store returns HITS, so the rerank stage has something to rerank. */
const makeRag: BuildAgentDeps['makeRag'] = async (input) => {
  const rag = (await constructionSeams.makeRag(input)) as IRag;
  rag.query = async () => ({ ok: true, value: [...HITS] });
  return rag;
};

function recordingModel() {
  const seen: DecisionRequest[] = [];
  const model: IDecisionModel = {
    decide: async (req) => {
      seen.push(req);
      const answers: Record<string, { type: 'noul'; probability: number }> = {};
      Object.keys(req.questions).forEach((k, i) => {
        answers[k] = { type: 'noul', probability: 1 - i * 0.1 };
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

describe('decision reranker wiring (§7.4)', () => {
  it('HTTP: a chat request on a session reaches the decision model', async () => {
    const { model, seen } = recordingModel();
    const server = new SmartServer(
      { ...configFrom(YAML), pluginLoader: noPlugins },
      {
        ...constructionSeams,
        makeRag,
        embedder: stubEmbedder,
        makeDecisionModel: async () => model,
      },
    );
    const handle = await server.start();
    try {
      const status = await post(handle.port, '/v1/chat/completions', {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: QUERY }],
      });
      assert.equal(status, 200);
      assert.ok(seen.length >= 1, 'the per-session agent must rerank');
      assert.equal(seen[0].state, QUERY);
      assert.deepEqual(
        passagesOf(seen[0]),
        HITS.map((h) => h.text),
      );
    } finally {
      await handle.close();
    }
  });

  it('embedded buildAgent(): the same YAML reaches the decision model', async () => {
    const { model, seen } = recordingModel();
    const { agent, close } = await buildAgent(
      { ...configFrom(YAML), pluginLoader: noPlugins },
      {
        ...constructionSeams,
        makeRag,
        embedder: stubEmbedder,
        makeDecisionModel: async () => model,
      },
    );
    try {
      await agent.process(QUERY);
      assert.ok(seen.length >= 1, 'the embedded agent must rerank');
      assert.equal(seen[0].state, QUERY);
      assert.deepEqual(
        passagesOf(seen[0]),
        HITS.map((h) => h.text),
      );
    } finally {
      await close();
    }
  });

  it('regression: a plugin reranker reaches the session agent', async () => {
    const calls: Array<{ query: string; texts: string[] }> = [];
    const plugin: IReranker = {
      rerank: async (query, r) => {
        calls.push({ query, texts: r.map((x) => x.text) });
        return { ok: true, value: r };
      },
    };
    // An absolute path: smart-server resolves `plugins: [...]` specifiers as
    // './' (cwd-relative), '/' (absolute) or a package name. The module's
    // `reranker` export is what mergePluginExports picks up (plugins/types.ts).
    const dir = mkdtempSync(join(tmpdir(), 'rr-plugin-'));
    const pluginPath = join(dir, 'reranker-plugin.mjs');
    writeFileSync(
      pluginPath,
      'export const reranker = globalThis.__decisionWiringPlugin;\n',
    );
    (globalThis as Record<string, unknown>).__decisionWiringPlugin = plugin;
    const cfg = {
      ...configFrom(BASE_YAML),
      plugins: [pluginPath],
    } as SmartServerConfig;
    const server = new SmartServer(cfg, {
      ...constructionSeams,
      makeRag,
      embedder: stubEmbedder,
    });
    const handle = await server.start();
    try {
      const status = await post(handle.port, '/v1/chat/completions', {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: QUERY }],
      });
      assert.equal(status, 200);
      assert.ok(
        calls.length >= 1,
        'a plugin reranker was a silent no-op on sessions',
      );
      assert.equal(calls[0].query, QUERY);
      assert.deepEqual(
        calls[0].texts,
        HITS.map((h) => h.text),
      );
    } finally {
      await handle.close();
      delete (globalThis as Record<string, unknown>).__decisionWiringPlugin;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
