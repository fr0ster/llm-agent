/**
 * Spec §13, §11.4, D58, D59: a major release — removed names are exported by no package,
 * and no file this plan adds or edits re-exports another package's names.
 * Reads the BUILT module namespaces (run after `npm run build`).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Runtime names removed by spec §13's migration table (types are covered by the typechecks). */
const REMOVED: Record<string, string[]> = {
  '@mcp-abap-adt/llm-agent-libs': [
    'DecisionReranker',
    'DECISION_RERANK_DEFAULT_TASK',
    'DECISION_RERANK_DEFAULT_CRITERIA',
    'LlmReranker',
    'NoopReranker',
    'TOOL_QUESTION',
    'PASSAGE_QUESTION',
    'wrapDecisionModel',
    'ProbabilityReranker',
    'RelevanceReranker',
  ],
  '@mcp-abap-adt/ollama-embedder': ['OllamaRag'],
};

test('no package exports a removed or moved name', async () => {
  const offenders: string[] = [];
  for (const [pkg, names] of Object.entries(REMOVED)) {
    const ns = (await import(pkg)) as Record<string, unknown>;
    for (const n of names) if (n in ns) offenders.push(`${pkg}: ${n}`);
  }
  assert.deepEqual(offenders, []);
});

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (
      e === 'node_modules' ||
      e === 'dist' ||
      e === '__tests__' ||
      e === '__typechecks__'
    )
      continue;
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (/\.ts$/.test(e) && !/\.test\.ts$/.test(e)) yield p;
  }
}

/** Packages this plan creates, or whose root it edits: none may re-export another package. */
const NO_REEXPORT = [
  'packages/llm-agent-reranker/src',
  'packages/sap-aicore-decision/src',
  'packages/llm-agent-rag/src',
  'packages/llm-agent-libs/src/index.ts',
  'packages/llm-agent-libs/src/collections',
];

test('no re-export of another package in the files this plan owns (D59)', () => {
  const RE = /export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*'@mcp-abap-adt\//;
  const offenders: string[] = [];
  for (const rel of NO_REEXPORT) {
    const p = join(ROOT, rel);
    let files: string[];
    try {
      files = statSync(p).isDirectory() ? [...tsFiles(p)] : [p];
    } catch {
      continue; // a package created by a later task
    }
    for (const f of files)
      if (RE.test(readFileSync(f, 'utf8'))) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});
