#!/usr/bin/env node
/**
 * Lockstep version bump for the monorepo. ALL non-private packages always share
 * ONE version (we do not version packages independently), so changesets — built
 * for independent/semver-derived bumps — is unnecessary here and its `fixed`
 * group mis-bumps a large set (minor -> major). This script is the version step.
 *
 * Usage:
 *   node scripts/bump-version.mjs <version> [notesFile]
 *   node scripts/bump-version.mjs 18.2.0 /tmp/notes.md
 *
 * It:
 *   1. sets `version` to <version> in every non-private packages/<pkg>/package.json,
 *   2. rewrites every internal `@mcp-abap-adt/*` range (dependencies /
 *      peerDependencies / devDependencies / optionalDependencies) to `^<version>`,
 *   3. prepends a `## <version>` section (with notes, if given) to each package's
 *      CHANGELOG.md (created if missing).
 * Run `npm install` afterwards to sync the lockfile.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2];
const notesFile = process.argv[3];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: node scripts/bump-version.mjs <version> [notesFile]');
  process.exit(1);
}
const notes = notesFile && existsSync(notesFile)
  ? readFileSync(notesFile, 'utf8').trim()
  : `Release ${version}.`;

const root = join(import.meta.dirname, '..');
const pkgsDir = join(root, 'packages');
const INTERNAL = '@mcp-abap-adt/';
const DEP_KEYS = [
  'dependencies',
  'peerDependencies',
  'devDependencies',
  'optionalDependencies',
];

const bumped = [];
for (const name of readdirSync(pkgsDir)) {
  const pkgPath = join(pkgsDir, name, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.private) continue;

  pkg.version = version;
  for (const key of DEP_KEYS) {
    const deps = pkg[key];
    if (!deps) continue;
    for (const dep of Object.keys(deps)) {
      if (dep.startsWith(INTERNAL)) deps[dep] = `^${version}`;
    }
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  bumped.push(pkg.name);

  // Prepend a CHANGELOG entry.
  const clPath = join(pkgsDir, name, 'CHANGELOG.md');
  const header = `# ${pkg.name}`;
  const entry = `## ${version}\n\n${notes}\n`;
  if (existsSync(clPath)) {
    const cl = readFileSync(clPath, 'utf8');
    const lines = cl.split('\n');
    // Insert the entry right after the first `# <title>` line (+ its blank line).
    const hIdx = lines.findIndex((l) => l.startsWith('# '));
    if (hIdx === -1) {
      writeFileSync(clPath, `${header}\n\n${entry}\n${cl}`);
    } else {
      const after = lines[hIdx + 1] === '' ? hIdx + 2 : hIdx + 1;
      lines.splice(after, 0, `${entry}`);
      writeFileSync(clPath, lines.join('\n'));
    }
  } else {
    writeFileSync(clPath, `${header}\n\n${entry}`);
  }
}

// Keep the aggregated root CHANGELOG current too (insert after `## [Unreleased]`).
const rootCl = join(root, 'CHANGELOG.md');
if (existsSync(rootCl)) {
  const cl = readFileSync(rootCl, 'utf8');
  const date = new Date().toISOString().slice(0, 10);
  const lines = cl.split('\n');
  const unrel = lines.findIndex((l) => /^##\s*\[?Unreleased\]?/i.test(l));
  if (unrel !== -1 && !cl.includes(`## [${version}]`)) {
    lines.splice(unrel + 1, 0, '', `## [${version}] — ${date}`, '', notes);
    writeFileSync(rootCl, lines.join('\n'));
  }
}

console.log(`bumped ${bumped.length} packages to ${version}:`);
for (const n of bumped) console.log(`  ${n}`);
console.log('\nNext: `npm install` to sync the lockfile, then build/test/commit/tag.');
