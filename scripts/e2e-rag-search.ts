#!/usr/bin/env node
/**
 * E2E RAG search: TranslatePreprocessor + Ollama embeddings + RRF.
 * Direct RAG test — no agent pipeline, no MCP client wrapper.
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

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY not set');
  process.exit(1);
}

const MCP_URL = 'http://localhost:3001/mcp/stream/http';
const OLLAMA_URL = 'http://localhost:11434';

// ---------------------------------------------------------------------------
// Fetch tools from MCP directly via HTTP
// ---------------------------------------------------------------------------

async function fetchMcpTools(): Promise<
  Array<{ name: string; description: string }>
> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  });
  const json = (await res.json()) as {
    result: { tools: Array<{ name: string; description: string }> };
  };
  return json.result.tools;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

interface TestCase {
  query: string;
  expectAny: string[];
  note: string;
}

const CASES: TestCase[] = [
  // Ukrainian — need translation
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

  // English — should work without translation
  { query: 'SM02 system messages', expectAny: ['RuntimeListSystemMessages', 'HandlerSystemMessageList'], note: 'EN: SAP t-code' },
  { query: 'get table data like SE16', expectAny: ['GetTableContents'], note: 'EN: data preview' },
  { query: 'expose CDS view as OData service', expectAny: ['CreateServiceDefinition', 'CreateServiceBinding'], note: 'EN: RAP service' },
  { query: 'find where class ZCL_UTILS is used', expectAny: ['GetWhereUsed'], note: 'EN: where-used' },
  { query: 'run unit tests', expectAny: ['RunUnitTest', 'HandlerUnitTestRun'], note: 'EN: unit tests' },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== E2E RAG Search: TranslatePreprocessor + Ollama + RRF ===\n');

  // 1. Fetch MCP tools
  console.log('Fetching MCP tools...');
  const tools = await fetchMcpTools();
  console.log(`  ${tools.length} tools loaded\n`);

  // 2. Create shared embedder + two RAG stores
  const embedder = new OllamaEmbedder({
    url: OLLAMA_URL,
    model: 'nomic-embed-text',
  });
  const helperLlm = makeDefaultLlm(DEEPSEEK_API_KEY!, 'deepseek-chat', 0.1);

  const ragTranslate = new VectorRag(embedder, {
    strategy: new RrfStrategy(),
    queryPreprocessors: [new TranslatePreprocessor(helperLlm)],
  });
  const ragBaseline = new VectorRag(embedder, {
    strategy: new RrfStrategy(),
  });

  // 3. Index tools (shared embedder = same vectors, but separate stores)
  console.log('Indexing tools...');
  const start = Date.now();
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    const text = `${t.name}: ${t.description}`;
    const meta = { id: `tool:${t.name}` };

    // Only embed once — use upsertPrecomputed for second store
    const { vector } = await embedder.embed(text);
    await ragTranslate.upsertPrecomputed(text, vector, meta);
    await ragBaseline.upsertPrecomputed(text, vector, meta);

    if ((i + 1) % 50 === 0) process.stdout.write(`  ${i + 1}/${tools.length}\n`);
  }
  console.log(`  Done: ${tools.length} tools in ${((Date.now() - start) / 1000).toFixed(1)}s\n`);

  // 4. Run queries
  let passT = 0;
  let passB = 0;

  for (const tc of CASES) {
    const label = `[${tc.note}]`.padEnd(28);
    process.stdout.write(`${label} "${tc.query}"\n`);

    const emb = new QueryEmbedding(tc.query, embedder);

    const [rT, rB] = await Promise.all([
      ragTranslate.query(emb, 5),
      ragBaseline.query(new QueryEmbedding(tc.query, embedder), 5),
    ]);

    const tRes = rT.ok ? rT.value : [];
    const bRes = rB.ok ? rB.value : [];

    const tIds = tRes.map((r) => (r.metadata.id as string).replace('tool:', ''));
    const bIds = bRes.map((r) => (r.metadata.id as string).replace('tool:', ''));

    const tHit = tc.expectAny.some((e) => tIds.includes(e));
    const bHit = tc.expectAny.some((e) => bIds.includes(e));

    if (tHit) passT++;
    if (bHit) passB++;

    const fmt = (ids: string[], scores: typeof tRes) =>
      ids.slice(0, 3).map((id, i) => `${id}(${scores[i]?.score.toFixed(3)})`).join(', ');

    console.log(`  translate ${tHit ? '✓' : '✗'}: [${fmt(tIds, tRes)}]`);
    console.log(`  baseline  ${bHit ? '✓' : '✗'}: [${fmt(bIds, bRes)}]`);
    console.log();
  }

  // Summary
  console.log('='.repeat(60));
  console.log(`  With TranslatePreprocessor: ${passT}/${CASES.length} (${((passT / CASES.length) * 100).toFixed(0)}%)`);
  console.log(`  Baseline (no translation):  ${passB}/${CASES.length} (${((passB / CASES.length) * 100).toFixed(0)}%)`);
  console.log(`  Improvement:                +${passT - passB} queries`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
