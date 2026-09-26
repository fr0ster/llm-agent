#!/usr/bin/env node
// Structural parse-check for every standalone example server config YAML:
// loadYamlConfig + resolveSmartServerConfig(skipProviderRuntimeChecks) and report
// SHAPE errors (removed/renamed keys, legacy pipeline shape).
// Credentials are not checked here: a config carries only credentialRef names, which
// llm-agent-server's composition root resolves at startup, and this script does not run it.
// Every failure is a SHAPE-FAIL.
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
  : ['docs/examples', 'examples', 'pipelines'];

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

// A DAG/subagent worker file's `llm:` names keys of its MAIN file's `llm:` map
// instead of holding a config of its own (§4.6.7): `llm: <key>` or
// `llm: { main?: <key>, helper?: <key>, classifier?: <key> }`. Real resolution
// strips it and resolves the rest with requireLlmSection:false, exactly what
// resolveSmartServerConfig does internally for a `subagents:` entry
// (resolveWorkerConfig) — mirror that here so a worker file validates
// standalone instead of failing on a section only its parent can complete.
const WORKER_LLM_ROLES = new Set(['main', 'helper', 'classifier']);
function isWorkerLlmShape(rawLlm) {
  if (typeof rawLlm === 'string') return rawLlm.length > 0;
  if (typeof rawLlm !== 'object' || rawLlm === null || Array.isArray(rawLlm)) {
    return false;
  }
  const entries = Object.entries(rawLlm);
  if (entries.length === 0) return false;
  return entries.every(
    ([k, v]) => WORKER_LLM_ROLES.has(k) && typeof v === 'string' && v.length > 0,
  );
}

let shape = 0;
for (const f of files) {
  try {
    const yaml = loadYamlConfig(f);
    const { llm: rawLlm, ...rest } = yaml;
    if (isWorkerLlmShape(rawLlm)) {
      resolveSmartServerConfig({}, rest, process.env, {
        skipProviderRuntimeChecks: true,
        configPath: f,
        requireLlmSection: false,
      });
    } else {
      resolveSmartServerConfig({}, yaml, process.env, {
        skipProviderRuntimeChecks: true,
        configPath: f,
      });
    }
  } catch (err) {
    const s = String(err);
    shape++;
    console.log(`SHAPE-FAIL  ${f}\n        → ${s.split('\n').filter((l) => l.trim())[1] ?? s.split('\n')[0]}`);
  }
}
console.log(`\n${files.length} configs — ${shape} SHAPE-FAIL`);
process.exit(shape > 0 ? 1 : 0);
