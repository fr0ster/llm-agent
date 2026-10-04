import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { resolveSmartServerConfig } from '../config.js';
import { loadYamlConfig } from '../yaml-loader.js';

const LLM = 'llm:\n  provider: openai\n  model: gpt-4o\n';
const LLM_MAP =
  'llm:\n  main: { provider: openai, model: gpt-4o }\n  reranker: { provider: openai, model: gpt-4o-mini }\n';
const RAG = 'rag:\n  store: { type: in-memory }\n';
const DECISION = 'decision:\n  provider: typesafe\n';

/** `retrieval` lines are indented under `rag:` by the caller. */
function resolve(
  retrieval: string,
  opts: { llm?: string; extra?: string } = {},
) {
  return resolveSmartServerConfig(
    {},
    parse(
      (opts.llm ?? LLM) +
        RAG +
        `  retrieval:\n${retrieval
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n')}\n` +
        (opts.extra ?? ''),
    ),
    {},
    { skipProviderRuntimeChecks: true },
  );
}

describe('rag.retrieval resolution', () => {
  it('copies exactly the named fields; absent optionals stay absent', () => {
    const cfg = resolve(
      'tools: { strategy: rerank, reranker: decision, overfetch: 3 }',
      { extra: DECISION },
    );
    assert.deepEqual(cfg.rag?.retrieval, {
      tools: { strategy: 'rerank', reranker: 'decision', overfetch: 3 },
    });
  });

  it('an embedding entry is only its strategy', () => {
    const cfg = resolve('history: { strategy: embedding }');
    assert.deepEqual(cfg.rag?.retrieval, {
      history: { strategy: 'embedding' },
    });
  });

  it('keeps every field', () => {
    const cfg = resolve(
      'knowledge: { strategy: rerank-all, reranker: llm, llm: reranker, question: passage, task: pick, maxCandidates: 200 }',
      { llm: LLM_MAP },
    );
    assert.deepEqual(cfg.rag?.retrieval, {
      knowledge: {
        strategy: 'rerank-all',
        reranker: 'llm',
        llm: 'reranker',
        question: 'passage',
        task: 'pick',
        maxCandidates: 200,
      },
    });
  });

  it('absent retrieval stays absent', () => {
    const cfg = resolveSmartServerConfig(
      {},
      parse(LLM + RAG),
      {},
      { skipProviderRuntimeChecks: true },
    );
    assert.equal(cfg.rag && 'retrieval' in cfg.rag, false);
  });

  it('${VAR} overfetch arrives as a number', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'retrieval-cfg-'));
    const p = path.join(dir, 'c.yaml');
    writeFileSync(
      p,
      `${LLM}${DECISION}${RAG}  retrieval:\n    tools: { strategy: rerank, reranker: decision, overfetch: "\${N}" }\n`,
    );
    const cfg = resolveSmartServerConfig(
      {},
      loadYamlConfig(p, { N: '4' }),
      {},
      { skipProviderRuntimeChecks: true },
    );
    assert.equal(cfg.rag?.retrieval?.tools?.overfetch, 4);
  });
});

describe('rag.retrieval validation', () => {
  const cases: Array<
    [string, string, RegExp, { llm?: string; extra?: string }?]
  > = [
    [
      'unknown strategy',
      'tools: { strategy: nope }',
      /rag\.retrieval\.tools\.strategy/,
    ],
    [
      'unknown reranker',
      'tools: { strategy: rerank, reranker: nope }',
      /rag\.retrieval\.tools\.reranker/,
      { extra: DECISION },
    ],
    [
      'rerank without reranker',
      'tools: { strategy: rerank }',
      /rag\.retrieval\.tools\.reranker: required/,
    ],
    [
      'decision reranker without decision:',
      'tools: { strategy: rerank, reranker: decision }',
      /rag\.retrieval\.tools\.reranker: decision requires a decision: section/,
    ],
    [
      'llm reranker without llm:',
      'tools: { strategy: rerank, reranker: llm }',
      /rag\.retrieval\.tools\.llm: required/,
    ],
    [
      'llm reranker naming an absent key',
      'tools: { strategy: rerank, reranker: llm, llm: nope }',
      /rag\.retrieval\.tools\.llm: "nope" is not a key of the llm: map/,
      { llm: LLM_MAP },
    ],
    [
      'rerank-all without maxCandidates',
      'kb: { strategy: rerank-all, reranker: decision }',
      /rag\.retrieval\.kb\.maxCandidates: required/,
      { extra: DECISION },
    ],
    [
      'overfetch 0',
      'tools: { strategy: rerank, reranker: decision, overfetch: 0 }',
      /rag\.retrieval\.tools\.overfetch: must be a positive integer/,
      { extra: DECISION },
    ],
    [
      'unknown question',
      'tools: { strategy: embedding, question: other }',
      /rag\.retrieval\.tools\.question/,
    ],
    [
      'entry not a mapping',
      'tools: true',
      /rag\.retrieval\.tools: must be a mapping/,
    ],
  ];
  for (const [name, retrieval, re, o] of cases) {
    it(`rejects ${name}`, () => {
      assert.throws(() => resolve(retrieval, o), re);
    });
  }

  it('rejects retrieval that is not a mapping', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          parse(`${LLM}${RAG}  retrieval: 5\n`),
          {},
          { skipProviderRuntimeChecks: true },
        ),
      /rag\.retrieval: must be a mapping/,
    );
  });

  it('the old reranker: section is refused with a pointer', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          parse(`${LLM}${RAG}${DECISION}reranker:\n  type: decision\n`),
          {},
          { skipProviderRuntimeChecks: true },
        ),
      /reranker: removed — use rag\.retrieval\.<store>: \{ strategy: rerank, reranker: decision \}/,
    );
  });
});

describe('rag.retrieval is server-wide', () => {
  it('a worker config declaring rag.retrieval is refused', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'retrieval-worker-'));
    writeFileSync(
      path.join(dir, 'w.yaml'),
      `${RAG}  retrieval:\n    tools: { strategy: embedding }\n`,
    );
    const main = path.join(dir, 'main.yaml');
    writeFileSync(
      main,
      `${LLM}subagents:\n  - name: w\n    config: ./w.yaml\n`,
    );
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          loadYamlConfig(main, {}),
          {},
          { configPath: main, skipProviderRuntimeChecks: true },
        ),
      /subagent 'w' rag\.retrieval: strategies are server-wide — set them in the main config's rag\.retrieval/,
    );
  });
});
