/**
 * Class-level guard for the debug-trace area tagging.
 *
 * Three separate review rounds found the SAME defect shape: a `logStep`
 * record whose name declares an area (`llm_*`, `mcp_*`, `rag_*`) but which
 * omits the `area` argument. Under a granular `SessionLogger`
 * (`DEBUG_LLM=1` etc. -> `enabledAreas` is a Set, not `'all'`) an untagged
 * record is silently DROPPED, so the flag documented in `.env.template`
 * captures nothing.
 *
 * Per-site tests only catch the sites someone remembered to write a test
 * for. This scans the source instead, so a newly added `mcp_*`/`rag_*`/
 * `llm_*` record that forgets its tag fails the suite immediately.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Repo `packages/` root, derived from this test file's location. */
const PACKAGES_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/** Record-name prefix -> the `DebugArea` its `logStep` call must pass. */
const PREFIX_TO_AREA: ReadonlyArray<readonly [string, string]> = [
  ['llm_', 'llm'],
  ['mcp_', 'mcp'],
  ['rag_', 'rag'],
];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts')) continue;
    if (full.includes('__tests__')) continue;
    acc.push(full);
  }
  return acc;
}

/**
 * Extract the argument text of every `logStep(` call, balancing parens so a
 * multi-line call (the common formatting for these records) is captured
 * whole rather than truncated at the first newline.
 */
function logStepCalls(src: string): string[] {
  const calls: string[] = [];
  const needle = 'logStep(';
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) return calls;
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(src.slice(at + needle.length, i));
    from = i + 1;
  }
}

test('every llm_/mcp_/rag_ logStep record passes its matching debug area', () => {
  const offenders: string[] = [];

  for (const file of sourceFiles(PACKAGES_ROOT)) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('logStep(')) continue;

    for (const call of logStepCalls(src)) {
      const nameMatch = call.match(/^\s*[`'"]([a-z_]+)/);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      const hit = PREFIX_TO_AREA.find(([prefix]) => name.startsWith(prefix));
      if (!hit) continue;
      const [, area] = hit;
      if (!new RegExp(`['"]${area}['"]\\s*,?\\s*$`).test(call.trimEnd())) {
        offenders.push(
          `${file.slice(PACKAGES_ROOT.length)}: ${name}* missing area '${area}'`,
        );
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `logStep records declaring an area in their name must pass it as the ` +
      `third argument, otherwise DEBUG_${''}* drops them:\n${offenders.join('\n')}`,
  );
});
