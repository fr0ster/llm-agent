/**
 * Repo-level licensing invariants.
 *
 * These guard a defect class that actually shipped: before v21.0.0 most
 * packages listed `LICENSE` in their `files` array while no such file existed
 * on disk, so their npm tarballs carried no licence text at all — and three
 * packages had no `license` field whatsoever and were published unlicensed.
 *
 * `LGPL-3.0-only` additionally requires BOTH texts to travel together: the
 * LGPL is a set of additional permissions layered on the GPL and cannot be
 * read alone, so `LICENSE` (LGPLv3) without `COPYING` (GPLv3) is incomplete.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGES_DIR = join(ROOT, 'packages');
const EXPECTED_LICENSE = 'LGPL-3.0-only';

/** First line of the canonical FSF text, used to detect a wrong/placeholder file. */
const LGPL_MARKER = 'GNU LESSER GENERAL PUBLIC LICENSE';
const GPL_MARKER = 'GNU GENERAL PUBLIC LICENSE';

type Pkg = {
  name?: string;
  private?: boolean;
  license?: string;
  files?: string[];
};

function publishedPackages(): Array<{ dir: string; pkg: Pkg }> {
  return readdirSync(PACKAGES_DIR)
    .map((name) => join(PACKAGES_DIR, name))
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .map((dir) => ({
      dir,
      pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Pkg,
    }))
    .filter(({ pkg }) => !pkg.private);
}

test('every published package declares the repo licence', () => {
  const packages = publishedPackages();
  assert.ok(packages.length > 0, 'no published packages found');

  for (const { pkg } of packages) {
    assert.equal(
      pkg.license,
      EXPECTED_LICENSE,
      `${pkg.name}: license must be '${EXPECTED_LICENSE}', got ${JSON.stringify(pkg.license)}`,
    );
  }
});

test('every published package ships BOTH licence texts in its tarball', () => {
  for (const { dir, pkg } of publishedPackages()) {
    const files = pkg.files ?? [];

    for (const entry of ['LICENSE', 'COPYING']) {
      // Declared in `files`, so npm actually packs it...
      assert.ok(
        files.includes(entry),
        `${pkg.name}: '${entry}' missing from the \`files\` array`,
      );
      // ...and present on disk, so what npm packs is not nothing.
      assert.ok(
        existsSync(join(dir, entry)),
        `${pkg.name}: '${entry}' is listed in \`files\` but absent on disk`,
      );
    }
  }
});

test('the shipped licence texts are the LGPL and the GPL, not placeholders', () => {
  const roots = [ROOT, ...publishedPackages().map(({ dir }) => dir)];

  for (const dir of roots) {
    const license = readFileSync(join(dir, 'LICENSE'), 'utf8');
    const copying = readFileSync(join(dir, 'COPYING'), 'utf8');

    assert.ok(
      license.includes(LGPL_MARKER),
      `${dir}: LICENSE is not the LGPL text`,
    );
    // The GPL marker also appears inside the LGPL text, so assert COPYING is
    // the GPL by ruling out that it is a second copy of the LGPL.
    assert.ok(
      copying.includes(GPL_MARKER) && !copying.includes(LGPL_MARKER),
      `${dir}: COPYING is not the standalone GPL text`,
    );
  }
});

test('all published packages share one lockstep version', () => {
  const versions = new Set(
    publishedPackages().map(
      ({ dir }) =>
        (
          JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
            version: string;
          }
        ).version,
    ),
  );
  assert.equal(
    versions.size,
    1,
    `expected one version across the monorepo, found: ${[...versions].join(', ')}`,
  );
});
