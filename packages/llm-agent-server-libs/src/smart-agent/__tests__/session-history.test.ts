import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  DecisionRequest,
  IEmbedder,
  ILlm,
  IProbabilityDecision,
  IRag,
  Message,
  RagResult,
} from '@mcp-abap-adt/llm-agent';
import { emptyLoadedPlugins } from '@mcp-abap-adt/llm-agent-libs';
import { parse } from 'yaml';
import { resolveSmartServerConfig } from '../config.js';
import {
  type BuildAgentDeps,
  SmartServer,
  type SmartServerConfig,
} from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

const ANSWER = 'the final answer about widgets';
const BASE_YAML = `
llm:
  provider: openai
  model: gpt-4o
rag:
  store:
    type: in-memory
`;
const AGENT = `agent:
  semanticHistoryEnabled: true
`;
const stubEmbedder = {
  embed: async () => ({ vector: [1, 0] }),
} as unknown as IEmbedder;
const noPlugins = { load: async () => emptyLoadedPlugins() };

function configFrom(text: string): SmartServerConfig {
  return {
    ...resolveSmartServerConfig(
      {},
      parse(text),
      {},
      { skipProviderRuntimeChecks: true },
    ),
    port: 0,
    skipModelValidation: true,
    pluginLoader: noPlugins,
  } as SmartServerConfig;
}

/** An LLM that always answers ANSWER and records every message list it saw. */
function recordingLlm() {
  const calls: Message[][] = [];
  const llm = {
    model: 'stub',
    chat: async (messages: Message[]) => {
      calls.push(messages);
      return {
        ok: true,
        value: { content: ANSWER, toolCalls: [], finishReason: 'stop' },
      };
    },
    streamChat: async function* () {
      yield { ok: true, value: { content: ANSWER, finishReason: 'stop' } };
    },
  } as unknown as ILlm;
  return { llm, calls };
}

/**
 * makeRag whose second store (the history store, see `_buildInfra`) is spied:
 * every query is recorded with its filter and the metadata of what came back.
 */
function spiedStores(fixedHistoryHits?: RagResult[]) {
  let n = 0;
  /** The sessionId of every record written to the history store. */
  const upserts: unknown[] = [];
  const historyQueries: Array<{
    filter: unknown;
    sessionIds: unknown[];
  }> = [];
  const makeRag: BuildAgentDeps['makeRag'] = async (input) => {
    const rag = (await constructionSeams.makeRag(input)) as IRag;
    if (n++ === 1) {
      const innerWriter = rag.writer?.bind(rag);
      if (innerWriter) {
        rag.writer = () => {
          const w = innerWriter();
          if (!w) return w;
          return {
            ...w,
            upsertRaw: async (id, text, meta, options) => {
              const res = await w.upsertRaw(id, text, meta, options);
              upserts.push((meta as { sessionId?: unknown }).sessionId);
              return res;
            },
          };
        };
      }
      const inner = rag.query.bind(rag);
      rag.query = async (embedding, k, options) => {
        const res = fixedHistoryHits
          ? { ok: true as const, value: [...fixedHistoryHits] }
          : await inner(embedding, k, options);
        historyQueries.push({
          filter: (options as { ragFilter?: unknown } | undefined)?.ragFilter,
          sessionIds: res.ok
            ? res.value.map(
                (r) => (r.metadata as { sessionId?: unknown }).sessionId,
              )
            : [],
        });
        return res;
      };
    }
    return rag;
  };
  return { makeRag, historyQueries, upserts };
}

function post(port: number, session: string, content: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content }],
    });
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          cookie: `sid=${session}`,
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

async function waitFor(cond: () => boolean): Promise<void> {
  const until = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > until) throw new Error('condition not met in 5s');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('session agents read the shared history store (§14.3)', () => {
  it('two sessions share one store; each reads only its own turns; summaries carry the answer', async () => {
    const { llm, calls } = recordingLlm();
    const { makeRag, historyQueries, upserts } = spiedStores();
    const server = new SmartServer(
      configFrom(`${BASE_YAML}${AGENT}  historyAutoSummarizeLimit: 5\n`),
      {
        ...constructionSeams,
        makeLlm: async () => llm,
        makeRag,
        embedder: stubEmbedder,
      } as BuildAgentDeps,
    );
    const handle = await server.start();
    try {
      assert.equal(await post(handle.port, 'A', 'question from A'), 200);
      await waitFor(() =>
        calls.some(
          (m) =>
            m.some((x) => String(x.content).includes('question from A')) &&
            m.some((x) => String(x.content).includes(ANSWER)),
        ),
      );
      assert.equal(await post(handle.port, 'B', 'question from B'), 200);
      // Both turns reach the shared store (one store, two owners) before
      // anyone reads: the filter alone must hide the other session's turn.
      await waitFor(() => upserts.includes('A') && upserts.includes('B'));
      for (const who of ['A', 'B']) {
        const before = historyQueries.length;
        assert.equal(await post(handle.port, who, `second from ${who}`), 200);
        await waitFor(() => historyQueries.length > before);
        const read = historyQueries[before];
        assert.equal(
          (read.filter as { sessionId?: string }).sessionId,
          who,
          'the read is scoped to the session',
        );
        assert.ok(read.sessionIds.length > 0, `${who}'s own turn is read back`);
        assert.ok(
          read.sessionIds.every((x) => x === who),
          `only session ${who}'s turns, got ${JSON.stringify(read.sessionIds)}`,
        );
      }
    } finally {
      await handle.close();
    }
  });

  it('rag.retrieval.history (decision) reranks the history read of a session request', async () => {
    const { llm } = recordingLlm();
    const hits: RagResult[] = [
      { text: 'history one', metadata: { id: 'h1' }, score: 0.5 },
      { text: 'history two', metadata: { id: 'h2' }, score: 0.4 },
    ];
    const { makeRag } = spiedStores(hits);
    const seen: DecisionRequest[] = [];
    const model: IProbabilityDecision = {
      decide: async (req: DecisionRequest, _o?: CallOptions) => {
        seen.push(req);
        const answers: Record<string, { type: 'noul'; probability: number }> =
          {};
        for (const k of Object.keys(req.questions)) {
          answers[k] = { type: 'noul', probability: 0.9 };
        }
        return { ok: true, value: { model: 'fake', answers } };
      },
    };
    const server = new SmartServer(
      configFrom(
        `${BASE_YAML}  retrieval:\n    history:\n      strategy: rerank\n      reranker: decision\n${AGENT}decision:\n  provider: typesafe\n`,
      ),
      {
        ...constructionSeams,
        makeLlm: async () => llm,
        makeRag,
        embedder: stubEmbedder,
        makeDecisionModel: async () => model,
      } as BuildAgentDeps,
    );
    const handle = await server.start();
    try {
      assert.equal(await post(handle.port, 'A', 'find history'), 200);
      assert.ok(
        seen.length >= 1,
        'the decision model reranked the history read of a session request',
      );
    } finally {
      await handle.close();
    }
  });
});
