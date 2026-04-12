#!/usr/bin/env node
/**
 * E2E RAG search test: DeepSeek LLM + Ollama embeddings + MCP tools.
 * Tests the LEGACY pipeline (agent.ts hardcoded flow), not DefaultPipeline.
 *
 * Run:
 *   node --import tsx/esm scripts/e2e-rag-search.ts
 */

import { configDotenv } from 'dotenv';
configDotenv();

import { SmartAgentBuilder } from '../src/smart-agent/builder.js';
import { OllamaEmbedder, OllamaRag } from '../src/smart-agent/rag/ollama-rag.js';
import { RrfStrategy } from '../src/smart-agent/rag/search-strategy.js';
import { makeDefaultLlm } from '../src/smart-agent/providers.js';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY not set');
  process.exit(1);
}

const MCP_URL = 'http://localhost:3001/mcp/stream/http';
const OLLAMA_URL = 'http://localhost:11434';

interface TestCase {
  query: string;
  expectAny: string[];
  note: string;
}

const CASES: TestCase[] = [
  {
    query: 'Прочитай дампи через фіди',
    expectAny: ['RuntimeListFeeds', 'RuntimeListDumps', 'RuntimeGetDumpById'],
    note: 'UA: dumps via feeds',
  },
  {
    query: 'Які фіди можемо прочитати?',
    expectAny: ['RuntimeListFeeds', 'HandlerFeedList'],
    note: 'UA: available feeds',
  },
  {
    query: 'Покажи код класу ZCL_MY_APP',
    expectAny: ['ReadClass', 'GetClass'],
    note: 'UA: class source',
  },
  {
    query: 'Запусти юніт тести для класу',
    expectAny: ['RunUnitTest', 'CreateUnitTest', 'HandlerUnitTestRun'],
    note: 'UA: unit tests',
  },
  {
    query: 'SM02 system messages',
    expectAny: ['RuntimeListSystemMessages'],
    note: 'SAP t-code',
  },
];

async function main() {
  console.log('Building: DeepSeek + Ollama embeddings + MCP ...\n');

  const mainLlm = makeDefaultLlm(DEEPSEEK_API_KEY!, 'deepseek-chat', 0.3);
  const helperLlm = makeDefaultLlm(DEEPSEEK_API_KEY!, 'deepseek-chat', 0.1);

  const embedder = new OllamaEmbedder({ url: OLLAMA_URL, model: 'nomic-embed-text' });
  const toolsRag = new OllamaRag({
    ollamaUrl: OLLAMA_URL,
    model: 'nomic-embed-text',
    strategy: new RrfStrategy(),
  });

  const handle = await new SmartAgentBuilder({
    mcp: { type: 'http', url: MCP_URL },
    agent: {
      ragQueryK: 10,
      maxIterations: 1,
      classificationEnabled: false,
    },
  })
    .withMainLlm(mainLlm)
    .withHelperLlm(helperLlm)
    .withEmbedder(embedder)
    .setToolsRag(toolsRag)
    .build();

  const agent = handle.agent;
  console.log('Agent ready.\n');

  let passed = 0;
  let failed = 0;

  for (const tc of CASES) {
    const label = `[${tc.note}]`;
    process.stdout.write(`${label.padEnd(30)} "${tc.query}" ...\n`);

    try {
      const logSteps: { name: string; data: unknown }[] = [];
      const result = await agent.process(tc.query, {
        sessionLogger: {
          logStep(name: string, data: unknown) {
            logSteps.push({ name, data });
          },
        },
      });

      // Show pipeline trace
      for (const step of logSteps) {
        if (
          step.name.startsWith('rag_query') ||
          step.name === 'classification_skipped' ||
          step.name === 'classifier_response' ||
          step.name === 'tool_select'
        ) {
          const d = step.data as Record<string, unknown>;
          if (step.name.startsWith('rag_query')) {
            const results = (d.results as Array<{ id?: string; score?: number }>) || [];
            const top3 = results.slice(0, 3).map((r) => `${(r.id || '?').toString().replace('tool:', '')}(${(r.score || 0).toFixed(3)})`);
            console.log(`  ${step.name}: query="${(d.query as string || '').slice(0, 60)}" → [${top3.join(', ')}]`);
          } else {
            console.log(`  ${step.name}: ${JSON.stringify(d).slice(0, 200)}`);
          }
        }
      }

      // Check
      const rawStr = JSON.stringify(result.raw || {}).toLowerCase();
      const msgStr = (result.message || '').toLowerCase();
      const combined = rawStr + ' ' + msgStr;

      const found = tc.expectAny.filter((t) => combined.includes(t.toLowerCase()));

      if (found.length > 0) {
        console.log(`  → ✓ found: [${found.join(', ')}]\n`);
        passed++;
      } else {
        console.log(`  → ✗ expected: [${tc.expectAny.join(', ')}]`);
        console.log(`  llm: ${(result.message || '').slice(0, 120)}\n`);
        failed++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  → ✗ ERROR: ${msg.slice(0, 120)}\n`);
      failed++;
    }
  }

  console.log(`${'='.repeat(60)}`);
  console.log(`RESULTS: ${passed}/${CASES.length} passed, ${failed} failed`);
  console.log('='.repeat(60));

  await handle.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
