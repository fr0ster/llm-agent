/**
 * Isolated tool-search experiment — analyse RAG tool ranking WITHOUT the full
 * pipeline. Uses InMemoryRag (the SAME bag-of-words/TF matcher the live
 * `rag.type: in-memory` uses), the real 183-tool mcp-abap-adt corpus, and varies
 * the QUERY (bare / +needs / +intent) × k, plus an INTENT-ENRICHED embedding-text
 * corpus. Reports where GetInclude / GetIncludesList rank under each variation.
 *
 * Run: npx tsx experiments/2026-06-02-toolsearch/search-experiment.ts
 */
import { readFileSync } from 'node:fs';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent';

interface Tool {
  name: string;
  description: string;
}
const tools: Tool[] = JSON.parse(
  readFileSync(
    new URL('./tools.json', import.meta.url).pathname,
    'utf8',
  ),
);

// in-memory query only reads `.text`; toVector is never called (bag-of-words).
const q = (text: string) => ({
  text,
  async toVector(): Promise<number[]> {
    throw new Error('text-only');
  },
});

/** Derive a coarse intent verb from the tool name (read vs write vs exec). */
function intentOf(name: string): string {
  if (/^(Get|Read|List|Search|Find|Show)/.test(name)) return 'read get fetch';
  if (/^(Create|Update|Delete|Activate|Generate|Insert|Write)/.test(name))
    return 'write modify create';
  if (/^(Check|Run|Execute|Validate)/.test(name)) return 'check run execute';
  return '';
}

async function buildRag(enrichIntent: boolean): Promise<InMemoryRag> {
  const rag = new InMemoryRag();
  for (const t of tools) {
    const text = enrichIntent
      ? `Tool: ${t.name} [${intentOf(t.name)}] — ${t.description}`
      : `Tool: ${t.name} — ${t.description}`;
    await rag.upsert(text, { id: `tool:${t.name}` });
  }
  return rag;
}

const TARGETS = ['tool:GetInclude', 'tool:GetIncludesList', 'tool:GetProgram'];

async function rank(
  rag: InMemoryRag,
  text: string,
  k: number,
): Promise<{ top: string[]; pos: Record<string, string> }> {
  const res = await rag.query(q(text) as never, k);
  const ids = res.ok
    ? res.value.map((r) => String(r.metadata.id))
    : [];
  // full ranking (k=200) to find true position even if outside top-k
  const full = await rag.query(q(text) as never, 200);
  const fullIds = full.ok ? full.value.map((r) => String(r.metadata.id)) : [];
  const pos: Record<string, string> = {};
  for (const t of TARGETS) {
    const i = fullIds.indexOf(t);
    pos[t.replace('tool:', '')] =
      i === -1 ? 'absent' : `#${i} ${i < k ? '(in top-' + k + ')' : '(OUT)'}`;
  }
  return { top: ids.slice(0, 8).map((s) => s.replace('tool:', '')), pos };
}

const QUERIES: Record<string, string> = {
  bare: 'Review ABAP program ZDAZ_R_DELAYED_UPDATE, check security, performance, CleanCore, maintainability',
  '+needs':
    'Review ABAP program ZDAZ_R_DELAYED_UPDATE, check security, performance, CleanCore, maintainability\nNeeded: read the include bodies of the program',
  '+intent (read)':
    '[read get] Review ABAP program ZDAZ_R_DELAYED_UPDATE source including all includes, check security, performance, CleanCore, maintainability',
  'main+includes':
    'Read the MAIN program source (the program shell) AND read every INCLUDE body of the program; review security, performance, CleanCore, maintainability',
  'main-only': 'read the source code of ABAP program / report main shell',
  'needs-only': 'read the include bodies of the program (all includes)',
};

async function main() {
  for (const enrich of [false, true]) {
    const rag = await buildRag(enrich);
    console.log(
      `\n================ corpus: ${enrich ? 'INTENT-ENRICHED tool text' : 'plain (name — description)'} ================`,
    );
    for (const [label, text] of Object.entries(QUERIES)) {
      for (const k of [10, 20]) {
        const { top, pos } = await rank(rag, text, k);
        console.log(
          `\n[${label}] k=${k}\n  top: ${top.join(', ')}\n  GetInclude=${pos.GetInclude} | GetIncludesList=${pos.GetIncludesList} | GetProgram=${pos.GetProgram}`,
        );
      }
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
