/**
 * Repo-level invariant: a consumer's install holds ONE copy of every
 * `@mcp-abap-adt/*` package — ours and the shared `interfaces-*` ones.
 *
 * Two copies are not harmless here. `llm-agent-mcp` checks
 * `instanceof McpError` and `llm-agent-libs` checks `instanceof ClarifySignal`
 * / `NeedInfoSignal` / `CatalogCasError`, all classes of `@mcp-abap-adt/llm-agent`;
 * with two copies of it those checks silently fail. Its LLM throttle keeps its
 * gates in module state, so two copies throttle independently. And two copies
 * of an interface package are two versions of the same contract.
 *
 * The rule that guarantees one copy:
 *
 *   - Every library package declares each `@mcp-abap-adt/*` package it uses as
 *     a PEER, never a regular dependency. npm then installs the consumer's one
 *     copy, and a version outside the range fails the install with ERESOLVE
 *     instead of nesting a second copy.
 *   - Every package declares the same range for the same package.
 *   - `@mcp-abap-adt/llm-agent-server` is the binary: it is the root of its own
 *     tree, so it depends on all of them regularly and must itself provide every
 *     required peer of the libraries it ships.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGES_DIR = join(ROOT, 'packages');

/** The binary: the root of its own install tree, so it takes regular deps. */
const BINARY_PACKAGE = '@mcp-abap-adt/llm-agent-server';

const SCOPE = '@mcp-abap-adt/';
/** `from '…'`, `import('…')` and `import '…'` — not any string mentioning the scope. */
const SCOPED_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](@mcp-abap-adt\/[a-z0-9][a-z0-9.-]*)[^'"]*['"]/g;

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
}

interface WorkspacePackage {
  dir: string;
  pkg: PackageJson;
}

function workspacePackages(): WorkspacePackage[] {
  return readdirSync(PACKAGES_DIR)
    .map((entry) => join(PACKAGES_DIR, entry))
    .filter((dir) => statSync(dir).isDirectory())
    .map((dir) => ({
      dir,
      pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
    }));
}

const libraries = () =>
  workspacePackages().filter(({ pkg }) => pkg.name !== BINARY_PACKAGE);

function isTestPath(path: string): boolean {
  return /(\.test\.ts$|\/__tests__\/)/.test(path);
}

function productionSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (isTestPath(path)) continue;
    if (entry.isDirectory()) files.push(...productionSources(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

/** Scoped packages a workspace package's production source imports. */
function importedScopedPackages(dir: string, self: string): Set<string> {
  const imported = new Set<string>();
  for (const file of productionSources(join(dir, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(SCOPED_IMPORT)) {
      if (match[1] !== self) imported.add(match[1]);
    }
  }
  return imported;
}

test('no library has an @mcp-abap-adt/* package as a regular dependency', () => {
  const offenders: string[] = [];
  for (const { pkg } of libraries()) {
    for (const section of ['dependencies', 'optionalDependencies'] as const) {
      for (const dep of Object.keys(pkg[section] ?? {})) {
        if (dep.startsWith(SCOPE))
          offenders.push(`${pkg.name} ${section}: ${dep}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'declare these in peerDependencies');
});

test('every imported @mcp-abap-adt/* package is declared', () => {
  const missing: string[] = [];
  for (const { dir, pkg } of workspacePackages()) {
    const declared =
      pkg.name === BINARY_PACKAGE ? pkg.dependencies : pkg.peerDependencies;
    for (const name of importedScopedPackages(dir, pkg.name)) {
      if (!declared?.[name]) missing.push(`${pkg.name}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every package declares the same range for the same @mcp-abap-adt/* package', () => {
  const ranges = new Map<string, Map<string, string[]>>();
  for (const { pkg } of workspacePackages()) {
    const sections = [pkg.dependencies, pkg.peerDependencies];
    for (const section of sections) {
      for (const [name, range] of Object.entries(section ?? {})) {
        if (!name.startsWith(SCOPE)) continue;
        const byRange = ranges.get(name) ?? new Map<string, string[]>();
        byRange.set(range, [...(byRange.get(range) ?? []), pkg.name]);
        ranges.set(name, byRange);
      }
    }
  }
  const differing = [...ranges]
    .filter(([, byRange]) => byRange.size > 1)
    .map(
      ([name, byRange]) =>
        `${name}: ${JSON.stringify(Object.fromEntries(byRange))}`,
    );
  assert.deepEqual(differing, []);
});

test('the binary provides every required peer of the libraries it ships', () => {
  const byName = new Map(workspacePackages().map((w) => [w.pkg.name, w.pkg]));
  const binary = byName.get(BINARY_PACKAGE);
  assert.ok(binary, `${BINARY_PACKAGE} not found`);
  const provided = new Set(Object.keys(binary.dependencies ?? {}));
  const missing: string[] = [];
  for (const name of provided) {
    const lib = byName.get(name);
    if (!lib) continue;
    for (const peer of Object.keys(lib.peerDependencies ?? {})) {
      if (!peer.startsWith(SCOPE)) continue;
      if (lib.peerDependenciesMeta?.[peer]?.optional) continue;
      if (!provided.has(peer)) missing.push(`${name} needs ${peer}`);
    }
  }
  assert.deepEqual(missing, []);
});
