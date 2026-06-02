/**
 * SEMANTIC tool-search experiment — the decider: does a real embedder (SAP AI
 * Core) rank the read tools (GetProgram / GetInclude) reliably, where the live
 * in-memory bag-of-words FAILS (GetProgram #8..#28, GetInclude #73 bare)?
 *
 * Same 183-tool corpus + same query variants as search-experiment.ts, but real
 * embeddings + cosine. Tool vectors are cached to tools-vectors.json so re-runs
 * are instant (delete it to re-embed).
 *
 * Run: npx tsx experiments/2026-06-02-toolsearch/semantic-experiment.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Minimal .env loader (dotenv is not a root dep). Loads KEY=VALUE lines into
// process.env so the SAP embedder finds AICORE_SERVICE_KEY etc.
(() => {
  const envPath = `${process.cwd()}/.env`;
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
})();
import { isBatchEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  prefetchEmbedderFactories,
  resolveEmbedder,
} from '@mcp-abap-adt/llm-agent-rag';

interface Tool {
  name: string;
  description: string;
}
const dir = new URL('.', import.meta.url).pathname;
const tools: Tool[] = JSON.parse(readFileSync(`${dir}tools.json`, 'utf8'));
const toolText = (t: Tool) => `Tool: ${t.name} — ${t.description}`;
const vecFile = `${dir}tools-vectors.json`;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const QUERIES: Record<string, string> = {
  bare: 'Review ABAP program ZDAZ_R_DELAYED_UPDATE, check security, performance, CleanCore, maintainability',
  'main-only': 'read the source code of ABAP program / report main shell',
  'needs-only': 'read the include bodies of the program (all includes)',
  'main+includes':
    'Read the MAIN program source AND read every INCLUDE body of the program',
};
const TARGETS = ['GetProgram', 'GetInclude', 'GetIncludesList'];

async function main() {
  await prefetchEmbedderFactories(['sap-ai-core']);
  const embedder = resolveEmbedder({
    embedder: 'sap-ai-core',
    model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
    resourceGroup: process.env.SAP_AI_RESOURCE_GROUP ?? 'default',
  });

  let vectors: number[][];
  if (existsSync(vecFile)) {
    vectors = JSON.parse(readFileSync(vecFile, 'utf8'));
    console.log(`(loaded ${vectors.length} cached tool vectors)`);
  } else {
    console.log(`embedding ${tools.length} tools via SAP AI Core …`);
    const texts = tools.map(toolText);
    if (isBatchEmbedder(embedder)) {
      const res = await embedder.embedBatch(texts);
      vectors = res.map((r) => r.vector);
    } else {
      vectors = [];
      for (const t of texts) vectors.push((await embedder.embed(t)).vector);
    }
    writeFileSync(vecFile, JSON.stringify(vectors));
    console.log('cached tool vectors.');
  }

  for (const [label, text] of Object.entries(QUERIES)) {
    const qv = (await embedder.embed(text)).vector;
    const ranked = tools
      .map((t, i) => ({ name: t.name, score: cosine(qv, vectors[i]) }))
      .sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, 8).map((r) => r.name);
    const pos: Record<string, string> = {};
    for (const t of TARGETS) {
      const i = ranked.findIndex((r) => r.name === t);
      pos[t] = `#${i}${i < 10 ? ' (top-10)' : ' (OUT)'} score=${ranked[i].score.toFixed(3)}`;
    }
    console.log(
      `\n[${label}]\n  top: ${top.join(', ')}\n  ${TARGETS.map((t) => `${t}=${pos[t]}`).join('\n  ')}`,
    );
  }
}
main().catch((e) => {
  console.error('FAILED:', e?.message ?? e);
  process.exit(1);
});
