import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type DecisionRequest,
  type ILlm,
  type IProbabilityDecision,
  type IRag,
  type RagResult,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import {
  EmbeddingRetrieval,
  PASSAGE_QUESTION,
  RerankAllRetrieval,
  RerankedRetrieval,
  TOOL_QUESTION,
} from '@mcp-abap-adt/llm-agent-libs';
import { resolveRetrievalStrategies } from '../resolve-retrieval.js';

const HITS: RagResult[] = [
  { text: 'a', metadata: { id: 'a' }, score: 0.5 },
  { text: 'b', metadata: { id: 'b' }, score: 0.4 },
];

function storeRecording() {
  const ks: number[] = [];
  const store = {
    query: async (_q: unknown, k: number) => {
      ks.push(k);
      return { ok: true, value: [...HITS] };
    },
  } as unknown as IRag;
  return { store, ks };
}

function decisionModel() {
  const seen: DecisionRequest[] = [];
  const model: IProbabilityDecision = {
    decide: async (req) => {
      seen.push(req);
      const answers: Record<string, { type: 'noul'; probability: number }> = {};
      for (const k of Object.keys(req.questions)) {
        answers[k] = { type: 'noul', probability: 0.5 };
      }
      return { ok: true, value: { model: 'f', answers } };
    },
  };
  return { model, seen };
}

const taskOf = (req: DecisionRequest): unknown => {
  const q = Object.values(req.questions)[0];
  return q.type === 'noul'
    ? (q.instructions as { task?: unknown }).task
    : undefined;
};

const noLlm = async (): Promise<ILlm> => {
  throw new Error('no llm expected');
};

describe('resolveRetrievalStrategies', () => {
  it('nothing configured → an empty map, no seam needed', async () => {
    const m = await resolveRetrievalStrategies({ resolveLlm: noLlm });
    assert.equal(m.size, 0);
  });

  it('one strategy per key; embedding is explicit; decision model built once', async () => {
    const { model, seen } = decisionModel();
    let built = 0;
    const m = await resolveRetrievalStrategies({
      retrieval: {
        tools: { strategy: 'rerank', reranker: 'decision', overfetch: 3 },
        docs: {
          strategy: 'rerank-all',
          reranker: 'decision',
          maxCandidates: 7,
        },
        history: { strategy: 'embedding' },
      },
      decisionCfg: { provider: 'typesafe' },
      makeDecisionModel: async () => {
        built++;
        return model;
      },
      resolveLlm: noLlm,
    });
    assert.equal(built, 1);
    assert.ok(m.get('tools') instanceof RerankedRetrieval);
    assert.ok(m.get('docs') instanceof RerankAllRetrieval);
    assert.ok(m.get('history') instanceof EmbeddingRetrieval);

    const tools = storeRecording();
    await m.get('tools')?.retrieve(tools.store, new TextOnlyEmbedding('q'), 2);
    assert.deepEqual(tools.ks, [6], 'overfetch 3 × k 2');
    assert.equal(taskOf(seen[0]), TOOL_QUESTION.task, 'tools → tool question');

    const docs = storeRecording();
    await m.get('docs')?.retrieve(docs.store, new TextOnlyEmbedding('q'), 2);
    assert.deepEqual(docs.ks, [7], 'maxCandidates');
    assert.equal(taskOf(seen[1]), PASSAGE_QUESTION.task, 'else → passage');
  });

  it('question and task override the default wording', async () => {
    const { model, seen } = decisionModel();
    const m = await resolveRetrievalStrategies({
      retrieval: {
        notes: { strategy: 'rerank', reranker: 'decision', question: 'tool' },
        tools: { strategy: 'rerank', reranker: 'decision', task: 'Custom?' },
      },
      decisionCfg: { provider: 'typesafe' },
      makeDecisionModel: async () => model,
      resolveLlm: noLlm,
    });
    const s = storeRecording();
    await m.get('notes')?.retrieve(s.store, new TextOnlyEmbedding('q'), 1);
    await m.get('tools')?.retrieve(s.store, new TextOnlyEmbedding('q'), 1);
    assert.equal(taskOf(seen[0]), TOOL_QUESTION.task);
    assert.equal(taskOf(seen[1]), 'Custom?');
  });

  it('reranker: llm resolves the named llm: key', async () => {
    const keys: string[] = [];
    const llm = {
      model: 'r',
      chat: async () => ({
        ok: true,
        value: { content: '[0.2, 0.9]', toolCalls: [] },
      }),
    } as unknown as ILlm;
    const m = await resolveRetrievalStrategies({
      retrieval: {
        docs: { strategy: 'rerank', reranker: 'llm', llm: 'reranker' },
      },
      resolveLlm: async (key) => {
        keys.push(key);
        return llm;
      },
    });
    assert.deepEqual(keys, ['reranker']);
    const s = storeRecording();
    const r = await m
      .get('docs')
      ?.retrieve(s.store, new TextOnlyEmbedding('q'), 2);
    assert.ok(r?.ok);
    assert.deepEqual(
      r.value.map((x) => x.text),
      ['b', 'a'],
    );
  });

  it('a decision reranker without the seam → the Part 1 error naming it', async () => {
    await assert.rejects(
      resolveRetrievalStrategies({
        retrieval: { tools: { strategy: 'rerank', reranker: 'decision' } },
        decisionCfg: { provider: 'typesafe' },
        resolveLlm: noLlm,
      }),
      /BuildAgentDeps\.makeDecisionModel is required/,
    );
  });
});
