#!/usr/bin/env node
// Structural parse-check for every standalone example server config YAML:
// loadYamlConfig + resolveSmartServerConfig(skipProviderRuntimeChecks) and report
// SHAPE errors (removed/renamed keys, legacy pipeline shape). Credential errors
// (missing AICORE_SERVICE_KEY / apiKey — env not set, or a known subconfig-propagation
// gap) are NOT shape bugs and are reported separately, not counted as failures.
// docker-compose*.yml are skipped (not SmartServer configs).
// Usage: node scripts/check-example-configs.mjs [root ...]
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadYamlConfig,
  resolveSmartServerConfig,
} from '@mcp-abap-adt/llm-agent-server-libs';

const roots = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['docs/examples', 'examples'];

const CRED_RE = /AICORE_SERVICE_KEY|requires llm\.apiKey|apiKey to resolve/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.ya?ml$/.test(name) && !/docker-compose/.test(name)) yield p;
  }
}

const files = [];
for (const r of roots) {
  try {
    for (const f of walk(r)) files.push(f);
  } catch {}
}
files.sort();

let shape = 0;
let cred = 0;
for (const f of files) {
  try {
    const yaml = loadYamlConfig(f);
    resolveSmartServerConfig({}, yaml, process.env, {
      skipProviderRuntimeChecks: true,
      configPath: f,
    });
  } catch (err) {
    const s = String(err);
    if (CRED_RE.test(s)) {
      cred++;
    } else {
      shape++;
      console.log(`SHAPE-FAIL  ${f}\n        → ${s.split('\n').filter((l) => l.trim())[1] ?? s.split('\n')[0]}`);
    }
  }
}
console.log(
  `\n${files.length} configs — ${shape} SHAPE-FAIL, ${cred} credential-only (env not set; not a shape bug)`,
);
process.exit(shape > 0 ? 1 : 0);
