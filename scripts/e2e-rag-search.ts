#!/usr/bin/env node
/**
 * E2E RAG search comparison: baseline vs translate vs translate+intent enrichment.
 *
 * Run:
 *   node --import tsx/esm scripts/e2e-rag-search.ts
 */

import { configDotenv } from 'dotenv';
configDotenv();

import { OllamaEmbedder } from '../src/smart-agent/rag/ollama-rag.js';
import { VectorRag } from '../src/smart-agent/rag/vector-rag.js';
import { RrfStrategy } from '../src/smart-agent/rag/search-strategy.js';
import {
  TranslatePreprocessor,
  IntentEnricher,
} from '../src/smart-agent/rag/preprocessor.js';
import { QueryEmbedding } from '../src/smart-agent/rag/query-embedding.js';
import { makeDefaultLlm } from '../src/smart-agent/providers.js';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY not set');
  process.exit(1);
}

const MCP_URL = 'http://localhost:3001/mcp/stream/http';
const OLLAMA_URL = 'http://localhost:11434';

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

async function main() {
  console.log('=== E2E RAG: baseline vs translate vs translate+intent ===\n');

  const tools = await fetchMcpTools();
  console.log(`${tools.length} MCP tools loaded`);

  const embedder = new OllamaEmbedder({ url: OLLAMA_URL, model: 'nomic-embed-text' });
  const helperLlm = makeDefaultLlm(DEEPSEEK_API_KEY!, 'deepseek-chat', 0.1);

  // 3 RAG stores
  const ragBaseline = new VectorRag(embedder, { strategy: new RrfStrategy() });
  const ragTranslate = new VectorRag(embedder, {
    strategy: new RrfStrategy(),
    queryPreprocessors: [new TranslatePreprocessor(helperLlm)],
  });
  const ragIntent = new VectorRag(embedder, {
    strategy: new RrfStrategy(),
    queryPreprocessors: [new TranslatePreprocessor(helperLlm)],
    documentEnrichers: [new IntentEnricher(helperLlm)],
  });

  // Index: baseline + translate share same vectors; intent gets enriched text
  console.log('Indexing baseline + translate (shared vectors)...');
  let t0 = Date.now();
  for (const t of tools) {
    const text = `${t.name}: ${t.description}`;
    const { vector } = await embedder.embed(text);
    await ragBaseline.upsertPrecomputed(text, vector, { id: `tool:${t.name}` });
    await ragTranslate.upsertPrecomputed(text, vector, { id: `tool:${t.name}` });
  }
  console.log(`  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('Indexing intent-enriched (LLM per tool)...');
  t0 = Date.now();
  const batchSize = 10;
  const batchDelayMs = 1000;
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    const text = `${t.name}: ${t.description}`;
    await ragIntent.upsert(text, { id: `tool:${t.name}` });
    if ((i + 1) % batchSize === 0) {
      process.stdout.write(`  ${i + 1}/${tools.length}\r`);
      await new Promise((r) => setTimeout(r, batchDelayMs));
    }
  }
  console.log(`  Done: ${tools.length} tools in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Run queries
  const scores = { baseline: 0, translate: 0, intent: 0 };

  for (const tc of CASES) {
    const label = `[${tc.note}]`.padEnd(28);
    console.log(`${label} "${tc.query}"`);

    const [rB, rT, rI] = await Promise.all([
      ragBaseline.query(new QueryEmbedding(tc.query, embedder), 5),
      ragTranslate.query(new QueryEmbedding(tc.query, embedder), 5),
      ragIntent.query(new QueryEmbedding(tc.query, embedder), 5),
    ]);

    const check = (res: typeof rB) => {
      if (!res.ok) return { hit: false, ids: [] as string[] };
      const ids = res.value.map((r) => (r.metadata.id as string).replace('tool:', ''));
      return { hit: tc.expectAny.some((e) => ids.includes(e)), ids };
    };

    const fmt = (res: typeof rB) => {
      if (!res.ok) return 'ERROR';
      return res.value
        .slice(0, 3)
        .map((r) => `${(r.metadata.id as string).replace('tool:', '')}(${r.score.toFixed(3)})`)
        .join(', ');
    };

    const b = check(rB);
    const t = check(rT);
    const i = check(rI);

    if (b.hit) scores.baseline++;
    if (t.hit) scores.translate++;
    if (i.hit) scores.intent++;

    console.log(`  baseline  ${b.hit ? '✓' : '✗'}: [${fmt(rB)}]`);
    console.log(`  translate ${t.hit ? '✓' : '✗'}: [${fmt(rT)}]`);
    console.log(`  intent    ${i.hit ? '✓' : '✗'}: [${fmt(rI)}]`);
    console.log();
  }

  const total = CASES.length;
  console.log('='.repeat(65));
  console.log(`  Baseline (no preprocess):    ${scores.baseline}/${total} (${((scores.baseline / total) * 100).toFixed(0)}%)`);
  console.log(`  + TranslatePreprocessor:     ${scores.translate}/${total} (${((scores.translate / total) * 100).toFixed(0)}%)`);
  console.log(`  + Translate + IntentEnricher: ${scores.intent}/${total} (${((scores.intent / total) * 100).toFixed(0)}%)`);
  console.log('='.repeat(65));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
