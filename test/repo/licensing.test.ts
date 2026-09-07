/**
 * Repo-level licensing invariants.
 *
 * These guard a defect class that actually shipped: before v21.0.0 most
 * packages listed `LICENSE` in their `files` array while no such file existed
 * on disk, so their npm tarballs carried no licence text at all — and three
 * packages had no `license` field whatsoever and were published unlicensed.
 *
 * Layout since v22.0.0:
 *
 *   - The libraries are `LGPL-3.0-only`. The LGPL is a set of additional
 *     permissions layered on the GPL and cannot be read alone, so they ship
 *     BOTH `LICENSE` (LGPLv3) and `GPL-3.0.txt` (GPLv3).
 *   - `@mcp-abap-adt/llm-agent-server` is `GPL-3.0-only`. It exposes no library
 *     API, so it is the ready-to-run product; the GPL is standalone and it
 *     ships `LICENSE` alone.
 *   - The GPL text is deliberately NOT named `COPYING`. GitHub's licensee scans
 *     `LICENSE*`/`COPYING*` and, finding both, reports the repo as GPL-3.0 (see
 *     zeromq/jzmq). Keeping the base text out of that namespace is what makes
 *     GitHub resolve this repo as LGPL-3.0.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGES_DIR = join(ROOT, 'packages');

const LGPL_LICENSE = 'LGPL-3.0-only';
const GPL_LICENSE = 'GPL-3.0-only';

/** The one package licensed under the full GPL: the binary, no library exports. */
const GPL_PACKAGE = '@mcp-abap-adt/llm-agent-server';

/** The GPL text that the LGPL layers its additional permissions onto. */
const GPL_BASE_TEXT = 'GPL-3.0.txt';

/** First line of the canonical FSF text, used to detect a wrong/placeholder file. */
const LGPL_MARKER = 'GNU LESSER GENERAL PUBLIC LICENSE';
const GPL_MARKER = 'GNU GENERAL PUBLIC LICENSE';

/**
 * Filenames GitHub's licensee treats as a licence declaration. A second match
 * at the repo root flips the detected licence away from the LGPL.
 */
const LICENSEE_SCANNED = /^(licen[sc]e|copying|copyright|unlicense)(\..*)?$/i;

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

const expectedLicense = (pkg: Pkg): string =>
  pkg.name === GPL_PACKAGE ? GPL_LICENSE : LGPL_LICENSE;

test('every published package declares its licence', () => {
  const packages = publishedPackages();
  assert.ok(packages.length > 0, 'no published packages found');

  for (const { pkg } of packages) {
    assert.equal(
      pkg.license,
      expectedLicense(pkg),
      `${pkg.name}: license must be '${expectedLicense(pkg)}', got ${JSON.stringify(pkg.license)}`,
    );
  }
});

test('the GPL package is the binary, and it is the only one', () => {
  const gpl = publishedPackages().filter(
    ({ pkg }) => pkg.license === GPL_LICENSE,
  );

  assert.deepEqual(
    gpl.map(({ pkg }) => pkg.name),
    [GPL_PACKAGE],
    'exactly one package may carry the full GPL: the binary',
  );

  // The GPL is only defensible here because nothing can link against it.
  const pkg = JSON.parse(
    readFileSync(join(gpl[0].dir, 'package.json'), 'utf8'),
  ) as { exports?: Record<string, unknown> };
  const entryPoints = Object.keys(pkg.exports ?? {}).filter(
    (key) => key !== './package.json',
  );
  assert.deepEqual(
    entryPoints,
    [],
    `${GPL_PACKAGE}: exposes library entry points, so it must not be GPL`,
  );
});

test('every published package ships the licence texts its licence needs', () => {
  for (const { dir, pkg } of publishedPackages()) {
    const files = pkg.files ?? [];

    // The LGPL is not standalone, so its packages carry the GPL base text too.
    // `LICENSE` npm packs on its own; `GPL-3.0.txt` it does not, so the `files`
    // entry is what actually gets it into the tarball.
    const required =
      pkg.license === GPL_LICENSE ? ['LICENSE'] : ['LICENSE', GPL_BASE_TEXT];

    for (const entry of required) {
      assert.ok(
        files.includes(entry),
        `${pkg.name}: '${entry}' missing from the \`files\` array`,
      );
      assert.ok(
        existsSync(join(dir, entry)),
        `${pkg.name}: '${entry}' is listed in \`files\` but absent on disk`,
      );
    }

    if (pkg.license === GPL_LICENSE) {
      assert.ok(
        !existsSync(join(dir, GPL_BASE_TEXT)),
        `${pkg.name}: the GPL is standalone, '${GPL_BASE_TEXT}' is redundant here`,
      );
    }
  }
});

test('the shipped licence texts are the real FSF texts, not placeholders', () => {
  for (const { dir, pkg } of publishedPackages()) {
    const license = readFileSync(join(dir, 'LICENSE'), 'utf8');

    if (pkg.license === GPL_LICENSE) {
      // The GPL marker is a substring of the LGPL title, so rule out the LGPL.
      assert.ok(
        license.includes(GPL_MARKER) && !license.includes(LGPL_MARKER),
        `${pkg.name}: LICENSE is not the standalone GPL text`,
      );
      continue;
    }

    assert.ok(
      license.includes(LGPL_MARKER),
      `${pkg.name}: LICENSE is not the LGPL text`,
    );
    const base = readFileSync(join(dir, GPL_BASE_TEXT), 'utf8');
    assert.ok(
      base.includes(GPL_MARKER) && !base.includes(LGPL_MARKER),
      `${pkg.name}: ${GPL_BASE_TEXT} is not the standalone GPL text`,
    );
  }
});

test('the repo root declares the LGPL, and nothing shadows it', () => {
  const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
  assert.ok(license.includes(LGPL_MARKER), 'root LICENSE is not the LGPL text');

  const base = readFileSync(join(ROOT, GPL_BASE_TEXT), 'utf8');
  assert.ok(
    base.includes(GPL_MARKER) && !base.includes(LGPL_MARKER),
    `root ${GPL_BASE_TEXT} is not the standalone GPL text`,
  );

  // A second licensee-scanned file at the root makes GitHub report GPL-3.0.
  const scanned = readdirSync(ROOT).filter((name) =>
    LICENSEE_SCANNED.test(name),
  );
  assert.deepEqual(
    scanned,
    ['LICENSE'],
    'the root must expose exactly one licensee-scanned licence file',
  );
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
