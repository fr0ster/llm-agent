import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const packages = [
  'pg-vector-rag',
  'hana-vector-rag',
  'ollama-embedder',
] as const;

test('the record embedding rollout declares breaking schema and provider changes', (context) => {
  const changesets = packages.map(
    (name) => new URL(`.changeset/record-fragments-${name}.md`, root),
  );
  if (changesets.every((file) => !existsSync(file))) {
    context.skip('The release consumed the rollout changesets');
    return;
  }
  for (const [index, name] of packages.entries()) {
    assert.ok(
      readFileSync(changesets[index], 'utf8').includes(
        `"@mcp-abap-adt/${name}": major`,
      ),
    );
    assert.match(
      readFileSync(new URL(`packages/${name}/README.md`, root), 'utf8'),
      /^### Upgrade/m,
    );
  }
});
