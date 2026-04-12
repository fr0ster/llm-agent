#!/usr/bin/env node
/**
 * E2E RAG search: 4-way comparison of indexing strategies.
 *
 * 1. baseline:  original description only
 * 2. +synonym:  original + synonym variants (deterministic)
 * 3. +intent:   original + LLM intent keywords
 * 4. all:       original + synonym + intent (triple index)
 *
 * All use TranslatePreprocessor on queries + RRF strategy.
 *
 * Run:
 *   node --import tsx/esm scripts/e2e-rag-search.ts
 */

import { configDotenv } from 'dotenv';
configDotenv();

import { OllamaEmbedder } from '../src/smart-agent/rag/ollama-rag.js';
import { VectorRag } from '../src/smart-agent/rag/vector-rag.js';
import { RrfStrategy } from '../src/smart-agent/rag/search-strategy.js';
import { TranslatePreprocessor } from '../src/smart-agent/rag/preprocessor.js';
import { QueryEmbedding } from '../src/smart-agent/rag/query-embedding.js';
import { makeDefaultLlm } from '../src/smart-agent/providers.js';
import {
  OriginalToolIndexing,
  SynonymToolIndexing,
  IntentToolIndexing,
  type IToolDescriptor,
  type IToolIndexEntry,
  type IToolIndexingStrategy,
} from '../src/smart-agent/rag/tool-indexing-strategy.js';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY not set');
  process.exit(1);
}

const MCP_URL = 'http://localhost:3001/mcp/stream/http';
const OLLAMA_URL = 'http://localhost:11434';

async function fetchMcpTools(): Promise<IToolDescriptor[]> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const json = (await res.json()) as {
    result: { tools: IToolDescriptor[] };
  };
  return json.result.tools;
}

interface TestCase {
  query: string;
  expectAny: string[];
  note: string;
}

const CASES: TestCase[] = [
  { query: 'Прочитай дампи через фіди', expectAny: ['RuntimeListFeeds', 'RuntimeListDumps'], note: 'UA: dumps via feeds' },
  { query: 'Прочитай структуру таблиці T100', expectAny: ['ReadTable', 'GetTable', 'GetTableContents'], note: 'UA: table structure' },
  { query: 'Які фіди можемо прочитати?', expectAny: ['RuntimeListFeeds', 'HandlerFeedList'], note: 'UA: available feeds' },
  { query: 'Покажи код класу ZCL_MY_APP', expectAny: ['ReadClass', 'GetClass'], note: 'UA: class source' },
  { query: 'Де використовується інтерфейс IF_LOGGER', expectAny: ['GetWhereUsed'], note: 'UA: where-used' },
  { query: 'Запусти юніт тести для класу', expectAny: ['RunUnitTest', 'CreateUnitTest', 'HandlerUnitTestRun'], note: 'UA: unit tests' },
  { query: 'Знайди обʼєкт ZTEST_PROGRAM', expectAny: ['SearchObject'], note: 'UA: find object' },
  { query: 'Які дампи були сьогодні?', expectAny: ['RuntimeListDumps'], note: 'UA: today dumps' },
  { query: 'Створи нову CDS вʼюху', expectAny: ['CreateView'], note: 'UA: create CDS view' },
  { query: 'Перевір синтаксис програми', expectAny: ['HandlerCheckRun'], note: 'UA: syntax check' },
  { query: 'Прочитай клас ZCL_ORDER і покажи його транспорти', expectAny: ['ReadClass', 'GetClass', 'ListTransports', 'GetTransport'], note: 'UA: multi-step' },
  { query: 'SM02 system messages', expectAny: ['RuntimeListSystemMessages', 'HandlerSystemMessageList'], note: 'EN: SAP t-code' },
  { query: 'get table data like SE16', expectAny: ['GetTableContents'], note: 'EN: data preview' },
  { query: 'expose CDS view as OData service', expectAny: ['CreateServiceDefinition', 'CreateServiceBinding'], note: 'EN: RAP service' },
  { query: 'find where class ZCL_UTILS is used', expectAny: ['GetWhereUsed'], note: 'EN: where-used' },
  { query: 'run unit tests', expectAny: ['RunUnitTest', 'HandlerUnitTestRun'], note: 'EN: unit tests' },
];

/** Prepare all index entries for a tool using given strategies. */
async function prepareEntries(
  tool: IToolDescriptor,
  strategies: IToolIndexingStrategy[],
): Promise<IToolIndexEntry[]> {
  const results = await Promise.all(strategies.map((s) => s.prepare(tool)));
  return results.flat();
}

/** Extract tool name from RAG result id: tool:Name:suffix → Name */
function extractToolName(id: string): string {
  return id.replace(/^tool:/, '').replace(/:.*$/, '');
}

async function main() {
  console.log('=== E2E RAG: Indexing Strategy Comparison ===\n');

  const tools = await fetchMcpTools();
  console.log(`${tools.length} MCP tools loaded`);

  const embedder = new OllamaEmbedder({ url: OLLAMA_URL, model: 'nomic-embed-text' });
  const helperLlm = makeDefaultLlm(DEEPSEEK_API_KEY!, 'deepseek-chat', 0.1);
  const translatePP = new TranslatePreprocessor(helperLlm);

  // Strategies
  const original = new OriginalToolIndexing();
  const synonym = new SynonymToolIndexing();
  const intent = new IntentToolIndexing(helperLlm);

  // 4 RAG stores — all use translate + RRF
  const ragConfig = { strategy: new RrfStrategy(), queryPreprocessors: [translatePP] };

  type StoreConfig = { name: string; strategies: IToolIndexingStrategy[]; rag: VectorRag };
  const stores: StoreConfig[] = [
    { name: 'original', strategies: [original], rag: new VectorRag(embedder, { ...ragConfig }) },
    { name: 'orig+syn', strategies: [original, synonym], rag: new VectorRag(embedder, { ...ragConfig }) },
    { name: 'orig+intent', strategies: [original, intent], rag: new VectorRag(embedder, { ...ragConfig }) },
    { name: 'all', strategies: [original, synonym, intent], rag: new VectorRag(embedder, { ...ragConfig }) },
  ];

  // Index — generate entries then embed
  for (const sc of stores) {
    const label = sc.name.padEnd(12);
    process.stdout.write(`Indexing [${label}]...`);
    const t0 = Date.now();
    let entryCount = 0;

    for (let i = 0; i < tools.length; i++) {
      const entries = await prepareEntries(tools[i], sc.strategies);
      for (const entry of entries) {
        await sc.rag.upsert(entry.text, { id: entry.id });
        entryCount++;
      }
      if ((i + 1) % 50 === 0) process.stdout.write(` ${i + 1}`);
    }

    console.log(` → ${entryCount} entries in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  console.log();

  // Run queries
  const scores: Record<string, number> = {};
  for (const sc of stores) scores[sc.name] = 0;

  for (const tc of CASES) {
    const label = `[${tc.note}]`.padEnd(28);
    console.log(`${label} "${tc.query}"`);

    for (const sc of stores) {
      const emb = new QueryEmbedding(tc.query, embedder);
      const res = await sc.rag.query(emb, 5);
      const results = res.ok ? res.value : [];
      const ids = results.map((r) => extractToolName(r.metadata.id as string));
      const hit = tc.expectAny.some((e) => ids.includes(e));
      if (hit) scores[sc.name]++;

      const top3 = results
        .slice(0, 3)
        .map((r) => `${extractToolName(r.metadata.id as string)}(${r.score.toFixed(3)})`)
        .join(', ');
      console.log(`  ${sc.name.padEnd(12)} ${hit ? '✓' : '✗'}: [${top3}]`);
    }
    console.log();
  }

  // Summary
  const total = CASES.length;
  console.log('='.repeat(65));
  for (const sc of stores) {
    const pct = ((scores[sc.name] / total) * 100).toFixed(0);
    console.log(`  ${sc.name.padEnd(14)} ${scores[sc.name]}/${total} (${pct}%)`);
  }
  console.log('='.repeat(65));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
