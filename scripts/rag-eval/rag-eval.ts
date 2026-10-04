/**
 * RAG tool-retrieval eval: vectorize the MCP tool catalog into a store, then
 * embed English user queries and check whether tool selection finds the
 * expected tool. No LLM is involved.
 *
 * Every step goes through the server's own code, imported from package sources:
 *   - embedder: resolveRetrievalEmbedder over the composition root's resolveEmbedder
 *   - store:    toMakeRagInput + the composition root's makeRag
 *   - write:    vectorizeMcpTools, fed by a stub IMcpClient over the snapshot
 *   - select:   QueryEmbedding → store.query(K) → DEFAULT_TOOL_SELECTION →
 *               toolNameFromRecord, as ToolSelectHandler does
 *
 * Retrieval strategies (--retrieval): the store is wrapped with
 * applyRetrievalStrategy and queried through it, as the server does. The
 * `embedding` arm always runs and is the baseline the others are compared to.
 *
 * Usage: npx tsx scripts/rag-eval/rag-eval.ts [--matrix f] [--only name]
 *          [--k 5] [--queries f] [--tools f] [--json out.json]
 *          [--retrieval embedding,rerank,rerank-all] [--reranker decision,llm]
 *          [--overfetch 2] [--max-candidates 30] [--config f --llm-key KEY]
 * See scripts/rag-eval/README.md.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type {
  ILlm,
  ILogger,
  IMcpClient,
  IRag,
  IReranker,
  IRetrievalEmbedder,
  IRetrievalStrategy,
  McpTool,
  RagResult,
} from '../../packages/llm-agent/src/index.js';
import {
  QueryEmbedding,
  staticApiKey,
  TextOnlyEmbedding,
  toolNameFromRecord,
} from '../../packages/llm-agent/src/index.js';
import { NoopRequestLogger } from '../../packages/llm-agent-libs/src/logger/noop-request-logger.js';
import { vectorizeMcpTools } from '../../packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.js';
import { DEFAULT_TOOL_SELECTION } from '../../packages/llm-agent-libs/src/pipeline/tool-selection/index.js';
import {
  DecisionReranker,
  LlmReranker,
  TOOL_QUESTION,
} from '../../packages/llm-agent-libs/src/reranker/index.js';
import {
  applyRetrievalStrategy,
  EmbeddingRetrieval,
  RerankAllRetrieval,
  RerankedRetrieval,
} from '../../packages/llm-agent-libs/src/retrieval/index.js';
import { buildCompositionDeps } from '../../packages/llm-agent-server/src/composition/index.js';
import {
  type SmartServerEmbedderConfig,
  type SmartServerRagStoreConfig,
  toMakeRagInput,
} from '../../packages/llm-agent-server-libs/src/smart-agent/rag-config.js';
import { resolveRetrievalEmbedder } from '../../packages/llm-agent-server-libs/src/smart-agent/resolve-agent-embedder.js';
import type { SmartServerLlmConfig } from '../../packages/llm-agent-server-libs/src/smart-agent/smart-server.js';
import {
  get,
  loadYamlConfig,
} from '../../packages/llm-agent-server-libs/src/smart-agent/yaml-loader.js';
import { TypeSafeDecisionModel } from '../../packages/typesafe-decision/src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_KS = [1, 5, 10, 15] as const;

interface MatrixEntry {
  name: string;
  store: SmartServerRagStoreConfig;
  /** Absent: keyword-only (in-memory store only). */
  embedder?: SmartServerEmbedderConfig;
}
interface Case {
  query: string;
  expect: string[];
}
interface CaseResult {
  query: string;
  expect: string[];
  /** 1-based rank of the first expected tool in the raw query results; null = not in top maxK. */
  rank: number | null;
  /** An expected tool is in the selection made at K = --k. */
  selected: boolean;
  top5: string[];
  top3: string[];
}
/** One retrieval arm: a strategy (+ reranker) over the same written store. */
interface ArmSpec {
  label: string;
  /** Strategy name as printed: embedding | rerank | rerank-all. */
  retrieval: string;
  reranker?: string;
}
interface ArmResult {
  label: string;
  skipped?: string;
  recall?: Record<string, number>;
  selectedAtK?: number;
  mrr?: number;
  avgStoreMs?: number;
  /** Cases ranked strictly better / worse than the embedding baseline. */
  better?: number;
  worse?: number;
  cases?: CaseResult[];
}
interface ConfigResult {
  name: string;
  ok: boolean;
  error?: string;
  vectorized?: { total: number; vectorized: number; failed: string[] };
  /** Distinct tool records the store returns for a broad query — catches silent overwrites. */
  distinctRecords?: number;
  /** Catalog tools the store no longer returns at all (overwritten on write). */
  lostTools?: string[];
  /** Raw results with no tool name recoverable (no metadata.id `tool:*`). */
  unnamedResults?: number;
  scoreOrderViolations?: number;
  vectorizeMs?: number;
  avgEmbedMs?: number;
  avgStoreMs?: number;
  arms?: ArmResult[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** The stub MCP client: listTools returns the snapshot; nothing is ever called. */
function snapshotClient(tools: McpTool[]): IMcpClient {
  return {
    listTools: async () => ({ ok: true, value: tools }),
    callTool: async () => {
      throw new Error('rag-eval: callTool is not part of retrieval');
    },
  };
}

/** Collects the vectorization summary line the builder would log. */
function captureLogger(lines: string[]): ILogger {
  return {
    log: (e) => {
      const m = (e as { message?: unknown }).message;
      if (typeof m === 'string') lines.push(m);
    },
  };
}

function collectionFor(name: string, runId: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 30);
  return `rag_eval_${safe}_${runId}`;
}

function withCollection(
  store: SmartServerRagStoreConfig,
  collection: string,
): SmartServerRagStoreConfig {
  return { ...store, collectionName: collection };
}

/** Drop what the run created, so reruns never mix data. Best effort, reported. */
async function cleanup(
  store: SmartServerRagStoreConfig,
  rag: IRag,
): Promise<string> {
  switch (store.type) {
    case 'in-memory':
      return 'in-memory (nothing persisted)';
    case 'qdrant': {
      const res = await fetch(
        `${store.url.replace(/\/$/, '')}/collections/${store.collectionName}`,
        { method: 'DELETE' },
      );
      return `qdrant collection ${store.collectionName}: DELETE ${res.status}`;
    }
    case 'pg-vector':
    case 'hana-vector': {
      // The store's own pool: same address and credential, then closed.
      const client = (
        rag as unknown as {
          clientPromise?: Promise<{
            query(sql: string): Promise<unknown>;
            end(): Promise<void>;
          }>;
        }
      ).clientPromise;
      if (!client) return `${store.type}: no client to clean up with`;
      const c = await client;
      await c.query(`DROP TABLE IF EXISTS "${store.collectionName}"`);
      await c.end();
      return `${store.type} table ${store.collectionName}: dropped`;
    }
  }
}

async function evalConfig(
  entry: MatrixEntry,
  tools: McpTool[],
  cases: Case[],
  k: number,
  runId: string,
  arms: ArmSpec[],
  buildStrategy: (arm: ArmSpec) => Promise<IRetrievalStrategy | string>,
): Promise<ConfigResult> {
  const deps = buildCompositionDeps(process.env);
  const store = withCollection(entry.store, collectionFor(entry.name, runId));
  const rag = { store, embedder: entry.embedder };
  const catalog = new Set(tools.map((t) => t.name));
  const maxK = Math.max(k, ...REPORT_KS);

  // Resolved exactly as SmartServer.start does ("RAG resolution"): one
  // retrieval embedder — the store writes with embedDocument, the search
  // below embeds with embedQuery (an asymmetric model is two halves behind it).
  const embedder: IRetrievalEmbedder | undefined =
    await resolveRetrievalEmbedder(rag, undefined, deps.resolveEmbedder, {});
  const toolsRag = await deps.makeRag(
    toMakeRagInput(store, embedder, `matrix.${entry.name}`),
  );

  try {
    // Warm the embedder (model load, token fetch) outside every timing.
    if (embedder) await embedder.embedQuery('warm up');
    const logLines: string[] = [];
    const t0 = performance.now();
    const summary = await vectorizeMcpTools(
      [snapshotClient(tools)],
      toolsRag,
      new NoopRequestLogger(),
      captureLogger(logLines),
    );
    const vectorizeMs = performance.now() - t0;
    for (const l of logLines) console.log(`  [${entry.name}] ${l}`);
    if (!summary)
      throw new Error('vectorizeMcpTools wrote nothing (no writer)');
    const vectorized = {
      total: summary.total,
      vectorized: summary.vectorized,
      failed: summary.failed,
    };
    if (!summary.complete || summary.vectorized !== tools.length) {
      return {
        name: entry.name,
        ok: false,
        error: `vectorized ${summary.vectorized}/${tools.length} (failed: ${summary.failed.join(', ') || 'none'}, clientFailures: ${summary.clientFailures})`,
        vectorized,
        vectorizeMs,
      };
    }

    const embeddingFor = (text: string) =>
      embedder
        ? new QueryEmbedding(text, embedder)
        : new TextOnlyEmbedding(text);

    // Sanity: how many distinct tool records does the store actually hold?
    const probe = await toolsRag.query(
      embeddingFor('ABAP object source code read list'),
      tools.length * 3,
    );
    if (!probe.ok) throw probe.error;
    const distinct = new Set(
      probe.value
        .map((r) => toolNameFromRecord(r.metadata))
        .filter((n): n is string => n !== undefined),
    );

    // One embedding per case, shared by every arm (embed cost counted once).
    let embedMs = 0;
    const embeddings = [];
    for (const c of cases) {
      const embedding = embeddingFor(c.query);
      const e0 = performance.now();
      if (embedding instanceof QueryEmbedding) await embedding.toVector();
      embedMs += performance.now() - e0;
      embeddings.push(embedding);
    }

    let unnamed = 0;
    let orderViolations = 0;
    const armResults: ArmResult[] = [];
    let baseline: CaseResult[] | undefined;
    for (const arm of arms) {
      const strategy = await buildStrategy(arm);
      if (typeof strategy === 'string') {
        armResults.push({ label: arm.label, skipped: strategy });
        continue;
      }
      const wrapped = applyRetrievalStrategy(toolsRag, strategy);
      let storeMs = 0;
      const results: CaseResult[] = [];
      for (let ci = 0; ci < cases.length; ci++) {
        const c = cases[ci];
        const embedding = embeddings[ci];

        // Ranking at maxK through the strategy, for recall@N and MRR.
        const s0 = performance.now();
        const raw = await wrapped.query(embedding, maxK);
        storeMs += performance.now() - s0;
        if (!raw.ok) throw raw.error;
        const names = raw.value.map((r: RagResult) =>
          toolNameFromRecord(r.metadata),
        );
        unnamed += names.filter((n) => n === undefined).length;
        // Score order is a store contract; a reranker re-scores by design.
        if (arm.retrieval === 'embedding') {
          for (let i = 1; i < raw.value.length; i++) {
            if (raw.value[i].score > raw.value[i - 1].score + 1e-9)
              orderViolations++;
          }
        }
        const idx = names.findIndex(
          (n) => n !== undefined && c.expect.includes(n),
        );

        // The selection path at K, exactly as ToolSelectHandler.
        const atK = await wrapped.query(embedding, k);
        if (!atK.ok) throw atK.error;
        const picked = new Set(
          DEFAULT_TOOL_SELECTION.select(atK.value)
            .map((r) => toolNameFromRecord(r.metadata))
            .filter((n): n is string => n !== undefined && catalog.has(n)),
        );

        results.push({
          query: c.query,
          expect: c.expect,
          rank: idx === -1 ? null : idx + 1,
          selected: c.expect.some((e) => picked.has(e)),
          top5: names.slice(0, 5).map((n) => n ?? '<no-id>'),
          top3: names.slice(0, 3).map((n) => n ?? '<no-id>'),
        });
      }

      const n = results.length;
      const recall: Record<string, number> = {};
      for (const at of REPORT_KS) {
        recall[`@${at}`] =
          results.filter((r) => r.rank !== null && r.rank <= at).length / n;
      }
      const mrr =
        results.reduce((x, r) => x + (r.rank !== null ? 1 / r.rank : 0), 0) / n;
      if (arm.retrieval === 'embedding') baseline = results;
      const rankOf = (r: CaseResult | undefined) => r?.rank ?? 99;
      armResults.push({
        label: arm.label,
        recall,
        selectedAtK: results.filter((r) => r.selected).length / n,
        mrr,
        avgStoreMs: storeMs / n,
        better: baseline
          ? results.filter((r, i) => rankOf(r) < rankOf(baseline?.[i])).length
          : undefined,
        worse: baseline
          ? results.filter((r, i) => rankOf(r) > rankOf(baseline?.[i])).length
          : undefined,
        cases: results,
      });
    }

    return {
      name: entry.name,
      ok: true,
      vectorized,
      distinctRecords: distinct.size,
      lostTools: [...catalog].filter((t) => !distinct.has(t)),
      unnamedResults: unnamed,
      scoreOrderViolations: orderViolations,
      vectorizeMs,
      avgEmbedMs: embedMs / cases.length,
      arms: armResults,
    };
  } finally {
    try {
      console.log(
        `  [${entry.name}] cleanup: ${await cleanup(store, toolsRag)}`,
      );
    } catch (err) {
      console.log(
        `  [${entry.name}] cleanup FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

const pct = (x: number | undefined) =>
  x === undefined ? '-' : `${(x * 100).toFixed(1)}%`;
const ms = (x: number | undefined) =>
  x === undefined ? '-' : `${Math.round(x)} ms`;

const row = (a: ArmResult, k: number) => ({
  'recall@1': pct(a.recall?.['@1']),
  'recall@5': pct(a.recall?.['@5']),
  'recall@10': pct(a.recall?.['@10']),
  'recall@15': pct(a.recall?.['@15']),
  MRR: a.mrr?.toFixed(3),
  [`selected@K=${k}`]: pct(a.selectedAtK),
  'better/worse vs embedding':
    a.better === undefined ? '-' : `${a.better}/${a.worse}`,
  'store/query': ms(a.avgStoreMs),
});

function printConfig(r: ConfigResult, k: number, tools: number): void {
  console.log(`\n=== ${r.name} ===`);
  if (!r.ok) {
    console.log(`FAILED: ${r.error}`);
    return;
  }
  console.log(
    `vectorized ${r.vectorized?.vectorized}/${tools} in ${ms(r.vectorizeMs)}; ` +
      `store holds ${r.distinctRecords} distinct tool records; embed/query ${ms(r.avgEmbedMs)}`,
  );
  if (r.lostTools?.length)
    console.log(
      `WARNING: counted as vectorized but not retrievable: ${r.lostTools.join(', ')}`,
    );
  const ran = (r.arms ?? []).filter((a) => !a.skipped);
  console.table(Object.fromEntries(ran.map((a) => [a.label, row(a, k)])));
  for (const a of r.arms ?? [])
    if (a.skipped) console.log(`SKIPPED ${a.label}: ${a.skipped}`);
  if (r.unnamedResults)
    console.log(`WARNING: ${r.unnamedResults} results carried no tool id`);
  if (r.scoreOrderViolations)
    console.log(
      `WARNING: ${r.scoreOrderViolations} score-order inversions in results`,
    );
  for (const a of ran) {
    const misses = (a.cases ?? []).filter((c) => !c.selected);
    console.log(`[${a.label}] missed at K=${k}: ${misses.length}`);
    for (const m of misses) {
      console.log(
        `  - "${m.query}"\n    expect ${m.expect.join('|')}; rank ${m.rank ?? `>${Math.max(k, 15)}`}; top5: ${m.top5.join(', ')}`,
      );
    }
  }
}

const RETRIEVALS = ['embedding', 'rerank', 'rerank-all'] as const;
const RERANKERS = ['decision', 'llm'] as const;

function csv(
  value: string | undefined,
  allowed: readonly string[],
  flag: string,
  dflt: string[],
): string[] {
  const list = value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : dflt;
  for (const v of list)
    if (!allowed.includes(v))
      throw new Error(`--${flag}: '${v}' is not one of ${allowed.join('|')}`);
  return list;
}

function positiveInt(
  value: string | undefined,
  flag: string,
  dflt: number,
): number {
  const n = value === undefined ? dflt : Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`--${flag} must be an integer >= 1`);
  return n;
}

/** The embedding baseline first, then each requested rerank retrieval × reranker. */
function planArms(retrievals: string[], rerankers: string[]): ArmSpec[] {
  const arms: ArmSpec[] = [{ label: 'embedding', retrieval: 'embedding' }];
  for (const retrieval of retrievals) {
    if (retrieval === 'embedding') continue;
    for (const reranker of rerankers)
      arms.push({ label: `${retrieval}:${reranker}`, retrieval, reranker });
  }
  return arms;
}

/** A reranker, or the printed reason it cannot run (arm skipped, exit 0). */
async function buildReranker(
  kind: string,
  llmKey: string | undefined,
  configPath: string | undefined,
): Promise<IReranker | string> {
  if (kind === 'decision') {
    const key = process.env.DECISION_API_KEY;
    if (!key) return 'DECISION_API_KEY is not set';
    return new DecisionReranker(
      new TypeSafeDecisionModel({ credential: staticApiKey(key) }),
      TOOL_QUESTION,
    );
  }
  if (!configPath || !llmKey)
    return '--config and --llm-key are required for the llm reranker';
  const llmSection = get(loadYamlConfig(configPath), 'llm');
  const cfg = get(llmSection, llmKey) as SmartServerLlmConfig | undefined;
  if (!cfg) return `--config has no llm: entry '${llmKey}'`;
  let llm: ILlm;
  try {
    llm = await buildCompositionDeps(process.env).makeLlm(cfg);
  } catch (err) {
    return `llm '${llmKey}' cannot be built: ${err instanceof Error ? err.message : String(err)}`;
  }
  return new LlmReranker(llm, { question: { task: TOOL_QUESTION.task } });
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      matrix: { type: 'string', default: resolve(HERE, 'matrix.example.json') },
      only: { type: 'string' },
      k: { type: 'string', default: '5' },
      queries: { type: 'string', default: resolve(HERE, 'queries.en.json') },
      tools: {
        type: 'string',
        default: resolve(HERE, 'tools.mcp-abap-adt-readonly.json'),
      },
      json: { type: 'string' },
      retrieval: { type: 'string' },
      reranker: { type: 'string' },
      overfetch: { type: 'string' },
      'max-candidates': { type: 'string' },
      config: { type: 'string' },
      'llm-key': { type: 'string' },
    },
  });
  const k = Number.parseInt(values.k ?? '5', 10);
  if (!Number.isInteger(k) || k < 1) throw new Error(`--k must be >= 1`);
  const retrievals = csv(values.retrieval, RETRIEVALS, 'retrieval', [
    'embedding',
  ]);
  const rerankers = csv(values.reranker, RERANKERS, 'reranker', ['decision']);
  const overfetch = positiveInt(values.overfetch, 'overfetch', 2);
  const maxCandidates = positiveInt(
    values['max-candidates'],
    'max-candidates',
    30,
  );
  const arms = planArms(retrievals, rerankers);
  const rerankerCache = new Map<string, Promise<IReranker | string>>();
  const buildStrategy = async (
    arm: ArmSpec,
  ): Promise<IRetrievalStrategy | string> => {
    if (arm.retrieval === 'embedding') return new EmbeddingRetrieval();
    const kind = arm.reranker as string;
    if (!rerankerCache.has(kind))
      rerankerCache.set(
        kind,
        buildReranker(kind, values['llm-key'], values.config),
      );
    const reranker = await rerankerCache.get(kind);
    if (typeof reranker === 'string') return reranker;
    return arm.retrieval === 'rerank'
      ? new RerankedRetrieval(reranker, { overfetch })
      : new RerankAllRetrieval(reranker, { maxCandidates });
  };
  const tools = readJson<{ tools: McpTool[] }>(values.tools as string).tools;
  const cases = readJson<{ cases: Case[] }>(values.queries as string).cases;
  const matrix = readJson<{ configs: MatrixEntry[] }>(
    values.matrix as string,
  ).configs;
  const only = values.only?.split(',').map((s) => s.trim());
  const selected = only ? matrix.filter((m) => only.includes(m.name)) : matrix;
  if (selected.length === 0)
    throw new Error(`no config matches --only ${values.only}`);

  const runId = randomBytes(4).toString('hex');
  console.log(
    `rag-eval run ${runId}: ${tools.length} tools, ${cases.length} queries, K=${k}, configs: ${selected.map((s) => s.name).join(', ')}; arms: ${arms.map((a) => a.label).join(', ')}` +
      (arms.length > 1
        ? `; overfetch ${overfetch}, max-candidates ${maxCandidates}`
        : ''),
  );

  const results: ConfigResult[] = [];
  for (const entry of selected) {
    console.log(`\n--> ${entry.name}`);
    try {
      results.push(
        await evalConfig(entry, tools, cases, k, runId, arms, buildStrategy),
      );
    } catch (err) {
      results.push({
        name: entry.name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    printConfig(results[results.length - 1], k, tools.length);
  }

  console.log('\n=== summary ===');
  console.table(
    Object.fromEntries(
      results.flatMap((r) =>
        r.ok
          ? (r.arms ?? [])
              .filter((a) => !a.skipped)
              .map((a) => [`${r.name} / ${a.label}`, row(a, k)])
          : [[r.name, { error: r.error }]],
      ),
    ),
  );
  if (values.json) {
    writeFileSync(
      values.json,
      JSON.stringify({ runId, k, results }, null, 2),
      'utf8',
    );
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(2);
  },
);
