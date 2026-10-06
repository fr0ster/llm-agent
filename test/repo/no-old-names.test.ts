/**
 * Spec §13, §11.4, D58, D59: a major release — removed names are exported by no package,
 * and no file this plan adds or edits re-exports another package's names.
 * Reads the BUILT module namespaces (run after `npm run build`).
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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
    'OrchestratorError',
  ],
  '@mcp-abap-adt/llm-agent-server-libs/legacy/linear': ['CoordinatorHandler'],
  '@mcp-abap-adt/llm-agent-server-libs/legacy/dag': ['DagCoordinatorHandler'],
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
  const RE =
    /export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*'@mcp-abap-adt\//;
  const offenders: string[] = [];
  for (const rel of NO_REEXPORT) {
    const p = join(ROOT, rel);
    let files: string[];
    try {
      files = statSync(p).isDirectory() ? [...tsFiles(p)] : [p];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // a package created by a later task
      throw e;
    }
    for (const f of files)
      if (RE.test(readFileSync(f, 'utf8'))) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test('the legacy/flat subpath is gone (S12, migration line 67)', async () => {
  await assert.rejects(
    import('@mcp-abap-adt/llm-agent-server-libs/legacy/flat'),
    (e: NodeJS.ErrnoException) => e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  );
});

interface PublicEntry {
  pkg: string;
  subpath: string;
  dir: string;
  file: string;
}

/** Every `exports` path of every package whose target has a `.d.ts` (`./package.json` is skipped). */
function publicEntries(): PublicEntry[] {
  const entries: PublicEntry[] = [];
  const packagesDir = join(ROOT, 'packages');
  for (const name of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string;
      exports?: Record<string, string | { types?: string }>;
    };
    const dir = realpathSync(join(packagesDir, name));
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const types = typeof target === 'string' ? target : target.types;
      if (!types?.endsWith('.d.ts')) continue;
      entries.push({
        pkg: manifest.name,
        subpath,
        dir,
        file: join(dir, types),
      });
    }
  }
  return entries;
}

test("no public entry point exports another package's names (D59, S12)", () => {
  const entries = publicEntries();
  const unbuilt = entries
    .filter((e) => !existsSync(e.file))
    .map((e) => `${e.pkg} ${e.subpath}`);
  assert.deepEqual(unbuilt, [], 'run `npm run build` first');
  const program = ts.createProgram(
    entries.map((e) => e.file),
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    },
  );
  const checker = program.getTypeChecker();
  const offenders: string[] = [];
  for (const e of entries) {
    const source = program.getSourceFile(e.file);
    assert.ok(source, `${e.pkg} ${e.subpath}: ${e.file} is not in the program`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) continue; // an entry point that exports nothing
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const target =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      const foreign = (target.declarations ?? [])
        .map((d) => realpathSync(d.getSourceFile().fileName))
        .find((f) => !f.startsWith(e.dir + sep));
      if (foreign) {
        offenders.push(
          `${e.pkg} ${e.subpath}: ${exported.name} (declared in ${relative(ROOT, foreign)})`,
        );
      }
    }
  }
  assert.deepEqual(offenders, []);
});
