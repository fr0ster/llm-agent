/**
 * Repo-level invariant: the shared `@mcp-abap-adt/interfaces-*` packages are
 * peer dependencies, never regular ones.
 *
 * This guards a defect that reached consumers: every package depended on
 * `@mcp-abap-adt/interfaces-auth` as a regular dependency, and a consumer that
 * already had it (directly, or through another `@mcp-abap-adt/*` package) at a
 * version outside our range got a second copy nested under our packages.
 *
 * As peers, the consumer's copy is the one every package here uses: npm
 * installs one copy, and a version outside the range fails the install with
 * ERESOLVE instead of silently duplicating. Each package still imports the
 * types directly from the interface package it uses, and declares that peer
 * itself — so the ranges must be identical, or npm would have to satisfy the
 * narrowest one.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGES_DIR = join(ROOT, 'packages');

const INTERFACE_PACKAGE = /^@mcp-abap-adt\/interfaces-/;
const INTERFACE_IMPORT = /['"](@mcp-abap-adt\/interfaces-[^'"/]+)[^'"]*['"]/g;

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
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

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

/** Interface packages a workspace package's source imports (tests included). */
function importedInterfacePackages(dir: string): Set<string> {
  const imported = new Set<string>();
  for (const file of sourceFiles(join(dir, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(INTERFACE_IMPORT)) {
      imported.add(match[1]);
    }
  }
  return imported;
}

test('no package has @mcp-abap-adt/interfaces-* as a regular dependency', () => {
  const offenders: string[] = [];
  for (const { pkg } of workspacePackages()) {
    for (const section of ['dependencies', 'optionalDependencies'] as const) {
      for (const dep of Object.keys(pkg[section] ?? {})) {
        if (INTERFACE_PACKAGE.test(dep)) {
          offenders.push(`${pkg.name} ${section}: ${dep}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'declare these in peerDependencies');
});

test('every imported interface package is declared as a peer', () => {
  const missing: string[] = [];
  for (const { dir, pkg } of workspacePackages()) {
    for (const name of importedInterfacePackages(dir)) {
      if (!pkg.peerDependencies?.[name]) missing.push(`${pkg.name}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every package declares the same range for each interface package', () => {
  const ranges = new Map<string, Map<string, string[]>>();
  for (const { pkg } of workspacePackages()) {
    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (!INTERFACE_PACKAGE.test(name)) continue;
      const byRange = ranges.get(name) ?? new Map<string, string[]>();
      byRange.set(range, [...(byRange.get(range) ?? []), pkg.name]);
      ranges.set(name, byRange);
    }
  }
  assert.ok(ranges.size > 0, 'expected interface peers to be declared');
  for (const [name, byRange] of ranges) {
    assert.equal(
      byRange.size,
      1,
      `${name} has differing ranges: ${JSON.stringify(Object.fromEntries(byRange))}`,
    );
  }
});
