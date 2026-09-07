/**
 * Every package README is an npm landing page, so the badge header has to be
 * on all of them — it drifted once already, sitting only on the root README
 * while all 17 package READMEs had none.
 *
 * The licence badge is per package, not a copy of the root's pair: the root
 * carries both because the monorepo holds both licences, but a reader landing
 * on a single package must see that package's own licence, not a choice of two.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGES_DIR = join(ROOT, 'packages');

const SWU_BADGE = 'stand-with-ukraine.pp.ua';
const LGPL_BADGE = 'https://www.gnu.org/licenses/lgpl-3.0';
const GPL_BADGE = 'https://www.gnu.org/licenses/gpl-3.0';

/** The badge header sits directly under the H1, so only the top matters. */
const HEADER_LINES = 6;

type Pkg = { name?: string; private?: boolean; license?: string };

function packageReadmes(): Array<{ name: string; license: string; readme: string }> {
  return readdirSync(PACKAGES_DIR)
    .map((dir) => join(PACKAGES_DIR, dir))
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .map((dir) => ({
      dir,
      pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Pkg,
    }))
    .filter(({ pkg }) => !pkg.private)
    .map(({ dir, pkg }) => {
      const path = join(dir, 'README.md');
      assert.ok(existsSync(path), `${pkg.name}: no README.md`);
      return {
        name: pkg.name ?? dir,
        license: pkg.license ?? '',
        readme: readFileSync(path, 'utf8'),
      };
    });
}

const header = (readme: string): string =>
  readme.split('\n').slice(0, HEADER_LINES).join('\n');

test('every package README carries the Stand With Ukraine badge', () => {
  const readmes = packageReadmes();
  assert.ok(readmes.length > 0, 'no package READMEs found');

  for (const { name, readme } of readmes) {
    assert.ok(
      header(readme).includes(SWU_BADGE),
      `${name}: Stand With Ukraine badge missing from the README header`,
    );
  }
  assert.ok(
    header(readFileSync(join(ROOT, 'README.md'), 'utf8')).includes(SWU_BADGE),
    'root README: Stand With Ukraine badge missing from the header',
  );
});

test('each package README shows its own licence badge, and only that one', () => {
  for (const { name, license, readme } of packageReadmes()) {
    const head = header(readme);
    const isGpl = license === 'GPL-3.0-only';

    // `lgpl-3.0` contains `gpl-3.0`, so match the LGPL first and rule it out.
    const hasLgpl = head.includes(LGPL_BADGE);
    const hasGpl = head.replaceAll(LGPL_BADGE, '').includes(GPL_BADGE);

    assert.equal(
      isGpl ? hasGpl : hasLgpl,
      true,
      `${name}: README header is missing the ${license} badge`,
    );
    assert.equal(
      isGpl ? hasLgpl : hasGpl,
      false,
      `${name}: README header shows a licence badge other than its own (${license})`,
    );
  }
});
