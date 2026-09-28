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
 * Usage: npx tsx scripts/rag-eval/rag-eval.ts [--matrix f] [--only name]
 *          [--k 5] [--queries f] [--tools f] [--json out.json]
 * See scripts/rag-eval/README.md.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type {
  ILogger,
  IMcpClient,
  IRag,
  IRetrievalEmbedder,
  McpTool,
  RagResult,
} from '../../packages/llm-agent/src/index.js';
import {
  QueryEmbedding,
  TextOnlyEmbedding,
  toolNameFromRecord,
} from '../../packages/llm-agent/src/index.js';
import { NoopRequestLogger } from '../../packages/llm-agent-libs/src/logger/noop-request-logger.js';
import { vectorizeMcpTools } from '../../packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.js';
import { DEFAULT_TOOL_SELECTION } from '../../packages/llm-agent-libs/src/pipeline/tool-selection/index.js';
import { buildCompositionDeps } from '../../packages/llm-agent-server/src/composition/index.js';
import {
  type SmartServerEmbedderConfig,
  type SmartServerRagStoreConfig,
  toMakeRagInput,
} from '../../packages/llm-agent-server-libs/src/smart-agent/rag-config.js';
import { resolveRetrievalEmbedder } from '../../packages/llm-agent-server-libs/src/smart-agent/resolve-agent-embedder.js';

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
  recall?: Record<string, number>;
  selectedAtK?: number;
  mrr?: number;
  cases?: CaseResult[];
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

    let embedMs = 0;
    let storeMs = 0;
    let unnamed = 0;
    let orderViolations = 0;
    const results: CaseResult[] = [];
    for (const c of cases) {
      const embedding = embeddingFor(c.query);
      const e0 = performance.now();
      if (embedding instanceof QueryEmbedding) await embedding.toVector();
      embedMs += performance.now() - e0;

      // Raw ranking at maxK, for recall@N and MRR.
      const s0 = performance.now();
      const raw = await toolsRag.query(embedding, maxK);
      storeMs += performance.now() - s0;
      if (!raw.ok) throw raw.error;
      const names = raw.value.map((r: RagResult) =>
        toolNameFromRecord(r.metadata),
      );
      unnamed += names.filter((n) => n === undefined).length;
      for (let i = 1; i < raw.value.length; i++) {
        if (raw.value[i].score > raw.value[i - 1].score + 1e-9)
          orderViolations++;
      }
      const idx = names.findIndex(
        (n) => n !== undefined && c.expect.includes(n),
      );

      // The selection path at K, exactly as ToolSelectHandler.
      const atK = await toolsRag.query(embedding, k);
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
      });
    }

    const n = results.length;
    const recall: Record<string, number> = {};
    for (const at of REPORT_KS) {
      recall[`@${at}`] =
        results.filter((r) => r.rank !== null && r.rank <= at).length / n;
    }
    const mrr =
      results.reduce((s, r) => s + (r.rank !== null ? 1 / r.rank : 0), 0) / n;
    return {
      name: entry.name,
      ok: true,
      vectorized,
      distinctRecords: distinct.size,
      lostTools: [...catalog].filter((t) => !distinct.has(t)),
      unnamedResults: unnamed,
      scoreOrderViolations: orderViolations,
      vectorizeMs,
      avgEmbedMs: embedMs / n,
      avgStoreMs: storeMs / n,
      recall,
      selectedAtK: results.filter((r) => r.selected).length / n,
      mrr,
      cases: results,
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

function printConfig(r: ConfigResult, k: number, tools: number): void {
  console.log(`\n=== ${r.name} ===`);
  if (!r.ok) {
    console.log(`FAILED: ${r.error}`);
    return;
  }
  console.log(
    `vectorized ${r.vectorized?.vectorized}/${tools} in ${ms(r.vectorizeMs)}; ` +
      `store holds ${r.distinctRecords} distinct tool records`,
  );
  if (r.lostTools?.length)
    console.log(
      `WARNING: counted as vectorized but not retrievable: ${r.lostTools.join(', ')}`,
    );
  console.table({
    [r.name]: {
      'recall@1': pct(r.recall?.['@1']),
      'recall@5': pct(r.recall?.['@5']),
      'recall@10': pct(r.recall?.['@10']),
      'recall@15': pct(r.recall?.['@15']),
      MRR: r.mrr?.toFixed(3),
      [`selected@K=${k}`]: pct(r.selectedAtK),
      vectorize: ms(r.vectorizeMs),
      'embed/query': ms(r.avgEmbedMs),
      'store/query': ms(r.avgStoreMs),
    },
  });
  if (r.unnamedResults)
    console.log(`WARNING: ${r.unnamedResults} results carried no tool id`);
  if (r.scoreOrderViolations)
    console.log(
      `WARNING: ${r.scoreOrderViolations} score-order inversions in results`,
    );
  const misses = (r.cases ?? []).filter((c) => !c.selected);
  console.log(`missed at K=${k}: ${misses.length}`);
  for (const m of misses) {
    console.log(
      `  - "${m.query}"\n    expect ${m.expect.join('|')}; rank ${m.rank ?? `>${Math.max(k, 15)}`}; top5: ${m.top5.join(', ')}`,
    );
  }
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
    },
  });
  const k = Number.parseInt(values.k ?? '5', 10);
  if (!Number.isInteger(k) || k < 1) throw new Error(`--k must be >= 1`);
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
    `rag-eval run ${runId}: ${tools.length} tools, ${cases.length} queries, K=${k}, configs: ${selected.map((s) => s.name).join(', ')}`,
  );

  const results: ConfigResult[] = [];
  for (const entry of selected) {
    console.log(`\n--> ${entry.name}`);
    try {
      results.push(await evalConfig(entry, tools, cases, k, runId));
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
      results.map((r) => [
        r.name,
        r.ok
          ? {
              'recall@1': pct(r.recall?.['@1']),
              'recall@5': pct(r.recall?.['@5']),
              'recall@10': pct(r.recall?.['@10']),
              'recall@15': pct(r.recall?.['@15']),
              MRR: r.mrr?.toFixed(3),
              vectorize: ms(r.vectorizeMs),
              'query (embed+store)': ms(
                (r.avgEmbedMs ?? 0) + (r.avgStoreMs ?? 0),
              ),
            }
          : { error: r.error },
      ]),
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
