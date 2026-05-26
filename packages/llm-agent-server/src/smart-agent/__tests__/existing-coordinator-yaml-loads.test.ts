import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { assertCoordinatorConfigShape } from '../config.js';

// Walk up from cwd to find the repo root (the dir containing docs/examples).
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'docs', 'examples'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate repo root (docs/examples)');
}

const EXAMPLES = [
  'docs/examples/coordinator-orchestration.yaml',
  'docs/examples/coordinator-orchestration-deepseek.yaml',
];

describe('existing coordinator example YAMLs remain valid (backward-compat)', () => {
  const root = repoRoot();
  for (const rel of EXAMPLES) {
    it(`${rel} coordinator block is a valid linear shape`, () => {
      const full = path.join(root, rel);
      assert.ok(existsSync(full), `missing example: ${rel}`);
      const y = parseYaml(readFileSync(full, 'utf8')) as {
        coordinator?: Record<string, unknown>;
      };
      if (y.coordinator) {
        const coord = y.coordinator;
        assert.doesNotThrow(() => assertCoordinatorConfigShape(coord));
      }
    });
  }
});
