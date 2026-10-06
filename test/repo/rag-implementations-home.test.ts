// test/repo/rag-implementations-home.test.ts
/**
 * Spec §11.3, D57: the RAG implementations live in @mcp-abap-adt/llm-agent-rag.
 * - no cycle: nothing in @mcp-abap-adt/llm-agent, and nothing llm-agent-rag depends on,
 *   imports or declares llm-agent-rag;
 * - no file imports a moved name from @mcp-abap-adt/llm-agent (it no longer exports them),
 *   except the intentional negative-import fixtures of NEGATIVE_IMPORT_FIXTURES;
 * - OllamaRag is gone (spec S11).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOVED = new Set([
  'VectorRag',
  'VectorRagConfig',
  'InMemoryRag',
  'InMemoryRagConfig',
  'OverlayRag',
  'SessionScopedRag',
  'ActiveFilteringRag',
  'SimpleRagRegistry',
  'ragStoreKey',
  'InMemoryRagProvider',
  'InMemoryRagProviderConfig',
  'VectorRagProvider',
  'VectorRagProviderConfig',
  'SimpleRagProviderRegistry',
  'WeightedFusionStrategy',
  'RrfStrategy',
  'VectorOnlyStrategy',
  'Bm25OnlyStrategy',
  'CompositeStrategy',
  'CompositeStrategyEntry',
  'ISearchStrategy',
  'ISearchCandidate',
  'ISearchQuery',
  'IScoredResult',
  'ISearchContext',
  'NoopQueryPreprocessor',
  'NoopDocumentEnricher',
  'TranslatePreprocessor',
  'ExpandPreprocessor',
  'IntentEnricher',
  'PreprocessorChain',
  'LlmQueryExpander',
  'NoopQueryExpander',
  'buildRagCollectionToolEntries',
  'RagCallerIdentity',
  'RagCollectionToolOptions',
  'RagToolContext',
  'RagToolEntry',
]);
/** What llm-agent-rag depends on (peers + tsconfig references): none may import it. */
const BELOW_RAG = [
  'llm-agent',
  'qdrant-rag',
  'pg-vector-rag',
  'hana-vector-rag',
  'ollama-embedder',
  'openai-embedder',
  'sap-aicore-embedder',
];

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e === 'dist') continue;
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (/\.(ts|mts)$/.test(e)) yield p;
  }
}

test('nothing llm-agent-rag depends on imports or declares @mcp-abap-adt/llm-agent-rag', () => {
  const offenders: string[] = [];
  for (const pkg of BELOW_RAG) {
    const dir = join(ROOT, 'packages', pkg);
    if (
      readFileSync(join(dir, 'package.json'), 'utf8').includes(
        '"@mcp-abap-adt/llm-agent-rag"',
      )
    ) {
      offenders.push(`${pkg}/package.json`);
    }
    for (const f of tsFiles(join(dir, 'src'))) {
      if (/['"]@mcp-abap-adt\/llm-agent-rag['"/]/.test(readFileSync(f, 'utf8')))
        offenders.push(f);
    }
  }
  assert.deepEqual(offenders, []);
});

/**
 * The intentional negative-import fixtures: files that import a moved name from
 * @mcp-abap-adt/llm-agent ON PURPOSE, each import under `// @ts-expect-error`, to prove the old
 * path no longer compiles. Exact repo-relative paths — never a directory, glob or pattern (one
 * would hide a real stale import placed next to a fixture). The guard skips only these files;
 * `npm run typecheck` still checks each of them (last test below), so an import that compiled
 * again would fail there with TS2578.
 */
const NEGATIVE_IMPORT_FIXTURES: ReadonlySet<string> = new Set([
  'packages/llm-agent-rag/src/__typechecks__/rag-implementations-moved.ts', // Step 9
]);

const STMT =
  /(?:import|export)(?:\s+type)?\s*\{([^}]*)\}\s*from\s*'@mcp-abap-adt\/llm-agent';/g;

/** The moved names that `text` imports (or re-exports) from @mcp-abap-adt/llm-agent. */
function movedImports(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(STMT)) {
    for (const spec of m[1].split(',')) {
      const name = spec
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim();
      if (MOVED.has(name)) names.push(name);
    }
  }
  return names;
}

/** `<repo-relative path>: <name>` for every moved-name import outside the listed fixtures. */
function staleImports(
  files: Iterable<readonly [rel: string, text: string]>,
): string[] {
  const offenders: string[] = [];
  for (const [rel, text] of files) {
    if (NEGATIVE_IMPORT_FIXTURES.has(rel)) continue;
    for (const name of movedImports(text)) offenders.push(`${rel}: ${name}`);
  }
  return offenders;
}

/** Every package source file (tests and typechecks included), `scripts/` and `test/`. */
function* repoFiles(): Generator<readonly [string, string]> {
  const dirs = [
    ...readdirSync(join(ROOT, 'packages')).map((p) =>
      join(ROOT, 'packages', p, 'src'),
    ),
    join(ROOT, 'scripts'),
    join(ROOT, 'test'),
  ];
  for (const dir of dirs) {
    for (const f of tsFiles(dir)) {
      yield [
        relative(ROOT, f).split(sep).join('/'),
        readFileSync(f, 'utf8'),
      ] as const;
    }
  }
}

test('no file imports a moved name from @mcp-abap-adt/llm-agent', () => {
  assert.deepEqual(staleImports(repoFiles()), []);
});

test('the guard still fails an ordinary stale import; only the listed paths are exempt', () => {
  // built from OLD so this file's own text holds no import statement the scan of test/ would match
  const OLD = '@mcp-abap-adt/llm-agent';
  const stale = [
    `import { VectorRag } from '${OLD}';`,
    `import type { ISearchStrategy as Old } from '${OLD}';`,
  ].join('\n');
  const at = (rel: string) => [`${rel}: VectorRag`, `${rel}: ISearchStrategy`];
  // an ordinary source file
  assert.deepEqual(
    staleImports([['packages/llm-agent-libs/src/x.ts', stale]]),
    at('packages/llm-agent-libs/src/x.ts'),
  );
  // a typecheck file next to a fixture is not exempt: the list holds paths, not directories
  const sibling = 'packages/llm-agent-rag/src/__typechecks__/another.ts';
  assert.deepEqual(staleImports([[sibling, stale]]), at(sibling));
  // a contract that stays in llm-agent is no offence
  const kept = `import type { IRag, IQueryExpander } from '${OLD}';`;
  assert.deepEqual(
    staleImports([['packages/llm-agent-libs/src/y.ts', kept]]),
    [],
  );
  // the listed fixtures pass with the very same content
  for (const rel of NEGATIVE_IMPORT_FIXTURES)
    assert.deepEqual(staleImports([[rel, stale]]), []);
});

test('each listed fixture is a real negative fixture and npm run typecheck checks it', () => {
  const typecheck = readFileSync(join(ROOT, 'tsconfig.typecheck.json'), 'utf8');
  for (const rel of NEGATIVE_IMPORT_FIXTURES) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    const importLines = lines.flatMap((l, i) =>
      movedImports(l).length > 0 ? [i] : [],
    );
    assert.ok(
      importLines.length > 0,
      `${rel} imports no moved name — remove it from the list`,
    );
    for (const i of importLines) {
      assert.match(
        lines[i - 1] ?? '',
        /^\s*\/\/ @ts-expect-error /,
        `${rel}:${i + 1} is not under @ts-expect-error`,
      );
    }
    assert.ok(
      typecheck.includes(`"${rel}"`),
      `${rel} is missing from tsconfig.typecheck.json include`,
    );
  }
});

test('OllamaRag is removed (spec S11)', () => {
  const offenders = [...tsFiles(join(ROOT, 'packages'))].filter((f) =>
    /\bOllamaRag\b/.test(readFileSync(f, 'utf8')),
  );
  assert.deepEqual(offenders, []);
});
