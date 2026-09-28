#!/usr/bin/env node
/**
 * models:check — which SAP AI Core models work for chat and which for
 * embeddings, probed through the same providers the server uses
 * (`SapCoreAIProvider`, `SapAiCoreEmbedder`) and the same credential rule
 * (`credentialRef: <REF>` → `<REF>_SERVICE_KEY`).
 *
 * A repository tool, not a published command. From the repo root:
 *   npm run models:check                                   # the whole catalog, both modes
 *   npm run models:check -- gpt-4o text-embedding-3-small  # named models
 *   npm run models:check -- --chat | --embed               # one mode only
 *   npm run models:check -- --config smart-server.yaml     # the models a config uses
 *   npm run models:check -- --credential-ref AICORE        # read AICORE_SERVICE_KEY
 *   npm run models:check -- --env-path ./other.env         # env file to load
 *
 * The catalog's declared capabilities only set expectations: a reason is
 * printed when a declared (or, for an unlisted model, any) mode fails.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import {
  loadYamlConfig,
  resolveSmartServerConfig,
} from '@mcp-abap-adt/llm-agent-server-libs';
import { SapAiCoreEmbedder } from '@mcp-abap-adt/sap-aicore-embedder';
import {
  buildDestination,
  SapCoreAIProvider,
} from '@mcp-abap-adt/sap-aicore-llm';
import { configDotenv } from 'dotenv';
import {
  DEFAULT_EMBEDDER_REF,
  DEFAULT_LLM_REF,
  envCredentialEntries,
  memoizeCredentials,
} from '../../src/composition/credential-for.js';
import {
  extractCheckError,
  type ICatalogModel,
  type IModeProbe,
  type IProbeOutcome,
  isModelFailed,
  isUnexpectedFailure,
  oneLine,
  type ProbeMode,
  planProbes,
} from './catalog.js';
import { roleLlmConfigs } from './roles.js';

const HELP = `Usage: npm run models:check -- [model ...] [options]

  No model names            Check every model in the SAP AI Core catalog
  model1 model2             Check only these models
  --config <yaml>   -c      Check the models a server config uses, each in the
                            mode of its role, with the config's credentialRef
  --credential-ref <REF>    Account to use: reads <REF>_SERVICE_KEY
                            (default ${DEFAULT_LLM_REF}, i.e. ${DEFAULT_LLM_REF}_SERVICE_KEY)
  --env-path <file>         Env file to load (default: .env in the current directory)
  --resource-group <rg>     AI Core resource group (default: $SAP_AI_RESOURCE_GROUP or 'default')
  --embed-scenario <s>      orchestration | foundation-models (default: orchestration)
  --chat                    Probe chat mode only
  --embed                   Probe embedding mode only
  --timeout <ms>            Per-call timeout (default: 60000)
  --delay <ms>      -d      Delay between calls (default: 2000)
  --version         -v      Print the package version
  --help            -h      Show this help
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseCliArgs() {
  try {
    return parseArgs({
      options: {
        config: { type: 'string', short: 'c' },
        'credential-ref': { type: 'string' },
        'env-path': { type: 'string' },
        'resource-group': { type: 'string' },
        'embed-scenario': { type: 'string' },
        chat: { type: 'boolean' },
        embed: { type: 'boolean' },
        timeout: { type: 'string' },
        delay: { type: 'string', short: 'd' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    fail(`${(err as Error).message}\nRun with --help for usage.`);
  }
}

const { values: args, positionals: requestedModels } = parseCliArgs();

if (args.version) {
  const pkg = JSON.parse(
    fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  process.stdout.write(`${pkg.name}@${pkg.version}\n`);
  process.exit(0);
}

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

if (args['env-path'] && !fs.existsSync(args['env-path'])) {
  fail(`Env file not found: ${args['env-path']}`);
}
configDotenv({
  path: path.resolve(args['env-path'] ?? '.env'),
  quiet: true,
});

const embedScenario = args['embed-scenario'] ?? 'orchestration';
if (
  embedScenario !== 'orchestration' &&
  embedScenario !== 'foundation-models'
) {
  fail(
    `--embed-scenario must be orchestration or foundation-models, got '${embedScenario}'`,
  );
}
const delayMs = Number(args.delay ?? 2000);
const timeoutMs = Number(args.timeout ?? 60000);
const resourceGroup =
  args['resource-group'] ?? process.env.SAP_AI_RESOURCE_GROUP ?? 'default';
const requestedModes: ProbeMode[] =
  args.chat === args.embed
    ? ['chat', 'embed']
    : args.chat
      ? ['chat']
      : ['embed'];

// ---------------------------------------------------------------------------
// Account: the server's credential rule, not the SDK's implicit lookup
// ---------------------------------------------------------------------------

interface IAccount {
  ref: string;
  credential: IBearerCredential;
  apiBaseUrl: string;
}

const credentialFor = memoizeCredentials(envCredentialEntries(process.env));

function accountFor(ref: string): IAccount {
  let entry: ReturnType<typeof credentialFor>;
  try {
    entry = credentialFor(ref);
  } catch (err) {
    fail((err as Error).message);
  }
  if (!entry?.credential) {
    const hint =
      ref === DEFAULT_LLM_REF && process.env.AICORE_SERVICE_KEY
        ? '\nAICORE_SERVICE_KEY is set: pass --credential-ref AICORE to use it.'
        : '';
    fail(
      `credentialRef '${ref}' resolves to nothing: set ${ref}_SERVICE_KEY to a SAP AI Core service key.${hint}`,
    );
  }
  if (entry.credential.kind !== 'bearer' || !entry.apiBaseUrl) {
    fail(
      `credentialRef '${ref}' must hold a SAP AI Core service key (${ref}_SERVICE_KEY), got ${entry.credential.kind}`,
    );
  }
  return { ref, credential: entry.credential, apiBaseUrl: entry.apiBaseUrl };
}

// ---------------------------------------------------------------------------
// What to check
// ---------------------------------------------------------------------------

interface IModelToCheck {
  model: string;
  probes: IModeProbe[];
  account: IAccount;
  /** Chat: the server passes none (AI Core's 'default'); embed: its own. */
  resourceGroup: string;
  scenario: 'orchestration' | 'foundation-models';
  /** Config roles this row answers for (config mode only). */
  roles: string[];
  /** The role's sampling knobs, sent exactly as the server sends them. */
  knobs: { temperature?: number; maxTokens?: number };
}

async function fetchCatalog(account: IAccount): Promise<ICatalogModel[]> {
  try {
    const { ScenarioApi } = await import('@sap-ai-sdk/ai-api');
    const result = await ScenarioApi.scenarioQueryModels('foundation-models', {
      'AI-Resource-Group': resourceGroup,
    }).execute(await buildDestination(account));
    return (result.resources as ICatalogModel[])
      .slice()
      .sort((a, b) => a.model.localeCompare(b.model));
  } catch (err) {
    fail(`Failed to fetch the model catalog: ${extractCheckError(err)}`);
  }
}

async function fromConfig(configPath: string): Promise<IModelToCheck[]> {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) fail(`Config file not found: ${configPath}`);
  let cfg: ReturnType<typeof resolveSmartServerConfig>;
  try {
    cfg = resolveSmartServerConfig({}, loadYamlConfig(resolved), process.env, {
      configPath: resolved,
    });
  } catch (err) {
    fail(`Invalid config ${configPath}: ${(err as Error).message}`);
  }

  const rows = new Map<string, IModelToCheck>();
  const add = (
    role: string,
    mode: ProbeMode,
    model: string,
    ref: string,
    group: string,
    scenario: IModelToCheck['scenario'],
    knobs: IModelToCheck['knobs'] = {},
  ) => {
    if (!requestedModes.includes(mode)) return;
    // Roles share a row only when the server would send the same request.
    const key = `${model}|${ref}|${group}|${scenario}|${knobs.temperature}|${knobs.maxTokens}`;
    const row = rows.get(key) ?? {
      model,
      probes: [],
      account: accountFor(ref),
      resourceGroup: group,
      scenario,
      roles: [],
      knobs,
    };
    if (!row.probes.some((p) => p.mode === mode)) {
      row.probes.push({ mode, expected: true });
    }
    row.roles.push(role);
    rows.set(key, row);
  };

  const skipped: string[] = [];
  for (const { role, cfg: entry } of await roleLlmConfigs(cfg.llm)) {
    if (!entry.model) continue;
    if (entry.provider !== 'sap-ai-sdk') {
      skipped.push(`llm.${role} (${entry.provider ?? 'no provider'})`);
      continue;
    }
    add(
      `llm.${role}`,
      'chat',
      entry.model,
      entry.credentialRef ?? DEFAULT_LLM_REF,
      'default',
      embedScenario as IModelToCheck['scenario'],
      {
        ...(entry.temperature !== undefined
          ? { temperature: entry.temperature }
          : {}),
        ...(entry.maxTokens !== undefined
          ? { maxTokens: entry.maxTokens }
          : {}),
      },
    );
  }
  const embedder = cfg.rag?.embedder;
  if (embedder && 'provider' in embedder && embedder.provider) {
    if (embedder.provider !== 'sap-ai-core' || !embedder.model) {
      skipped.push(`rag.embedder (${embedder.provider})`);
    } else {
      add(
        'rag.embedder',
        'embed',
        embedder.model,
        embedder.credentialRef ?? DEFAULT_EMBEDDER_REF,
        embedder.resourceGroup ?? 'default',
        embedder.scenario ?? 'orchestration',
      );
    }
  }
  if (skipped.length > 0) {
    process.stderr.write(
      `  Not SAP AI Core, not checked here (validated at server startup): ${skipped.join(', ')}\n`,
    );
  }
  return [...rows.values()];
}

let modelsToCheck: IModelToCheck[];
if (args.config) {
  modelsToCheck = await fromConfig(args.config);
} else {
  const account = accountFor(args['credential-ref'] ?? DEFAULT_LLM_REF);
  const catalog = await fetchCatalog(account);
  const models =
    requestedModels.length > 0 ? requestedModels : catalog.map((c) => c.model);
  modelsToCheck = models.map((model) => ({
    model,
    probes: planProbes(
      catalog.find((c) => c.model === model),
      requestedModes,
    ),
    account,
    resourceGroup,
    scenario: embedScenario as IModelToCheck['scenario'],
    roles: [],
    knobs: {},
  }));
}

if (modelsToCheck.length === 0) {
  process.stdout.write('  Nothing to check.\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Probes — through the server's own providers
// ---------------------------------------------------------------------------

type CheckResult = { ok: boolean; detail: string; ms: number };

async function probeChat(row: IModelToCheck): Promise<CheckResult> {
  const start = Date.now();
  try {
    const llm = new SapCoreAIProvider({
      model: row.model,
      credential: row.account.credential,
      apiBaseUrl: row.account.apiBaseUrl,
      resourceGroup: row.resourceGroup,
      ...row.knobs,
    });
    const response = await llm.chat(
      [{ role: 'user', content: 'Reply with OK' }],
      undefined,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    return {
      ok: true,
      detail: oneLine(response.content, 30),
      ms: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      detail: extractCheckError(err),
      ms: Date.now() - start,
    };
  }
}

async function probeEmbed(row: IModelToCheck): Promise<CheckResult> {
  const start = Date.now();
  try {
    const embedder = new SapAiCoreEmbedder({
      model: row.model,
      credential: row.account.credential,
      apiBaseUrl: row.account.apiBaseUrl,
      resourceGroup: row.resourceGroup,
      scenario: row.scenario,
    });
    const { vector } = await embedder.embed('ping', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: vector.length > 0,
      detail: `${vector.length} dimensions`,
      ms: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      detail: extractCheckError(err),
      ms: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CELL = 18;

function cell(result: (CheckResult & { mode: ProbeMode }) | undefined): string {
  if (!result) return `${DIM}${'—'.padEnd(CELL)}${RESET}`;
  if (!result.ok) return `${RED}${'✗'.padEnd(CELL)}${RESET}`;
  const info = result.mode === 'embed' ? result.detail : `${result.ms}ms`;
  return `${GREEN}${`✓ ${info}`.padEnd(CELL)}${RESET}`;
}

const rule = `  ${'─'.repeat(38 + 2 * CELL + 2)}\n`;
const refs = [...new Set(modelsToCheck.map((m) => m.account.ref))].join(', ');
process.stdout.write(
  `\n  Checking ${modelsToCheck.length} model(s) — modes: ${requestedModes.join(', ')} — account: ${refs}\n`,
);
process.stdout.write(rule);
process.stdout.write(
  `  ${'Model'.padEnd(38)} ${'Chat'.padEnd(CELL)} ${'Embed'.padEnd(CELL)}\n`,
);
process.stdout.write(rule);

const okCount: Record<ProbeMode, number> = { chat: 0, embed: 0 };
const probedCount: Record<ProbeMode, number> = { chat: 0, embed: 0 };
let failedModels = 0;
let firstCall = true;

for (const row of modelsToCheck) {
  const results = new Map<ProbeMode, CheckResult & { mode: ProbeMode }>();
  for (const probe of row.probes) {
    if (!firstCall) await new Promise((r) => setTimeout(r, delayMs));
    firstCall = false;
    const result =
      probe.mode === 'embed' ? await probeEmbed(row) : await probeChat(row);
    results.set(probe.mode, { ...result, mode: probe.mode });
    probedCount[probe.mode]++;
    if (result.ok) okCount[probe.mode]++;
  }

  const outcomes: IProbeOutcome[] = row.probes.map((p) => ({
    ...p,
    ok: results.get(p.mode)?.ok ?? false,
  }));
  if (isModelFailed(outcomes)) failedModels++;

  const knobText = Object.entries(row.knobs)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const label = [row.roles.join(', '), knobText && `(${knobText})`]
    .filter(Boolean)
    .join(' ');
  const roles = label ? `  ${DIM}${label}${RESET}` : '';
  process.stdout.write(
    `  ${row.model.padEnd(38)} ${cell(results.get('chat'))} ${cell(results.get('embed'))}${roles}\n`,
  );
  for (const o of outcomes) {
    if (!isUnexpectedFailure(o)) continue;
    const why = o.expected ? 'declared, but failed' : 'failed';
    process.stdout.write(
      `  ${DIM}  ↳ ${o.mode} ${why}: ${results.get(o.mode)?.detail}${RESET}\n`,
    );
  }
}

process.stdout.write(rule);
const summary = requestedModes
  .filter((m) => probedCount[m] > 0)
  .map(
    (m) =>
      `${m === 'chat' ? 'Chat' : 'Embed'}: ${GREEN}${okCount[m]}${RESET}/${probedCount[m]}`,
  )
  .join('  ');
process.stdout.write(
  `  Models: ${modelsToCheck.length}  ${summary}  ${RED}Failed: ${failedModels}${RESET}\n\n`,
);

if (failedModels > 0) process.exit(1);
