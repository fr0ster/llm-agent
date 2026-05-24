#!/usr/bin/env node
/**
 * llm-agent — Global CLI for SmartServer
 *
 * Install globally:
 *   npm install -g @mcp-abap-adt/llm-agent
 *   llm-agent [options]
 *
 * Or run directly:
 *   node --import tsx/esm src/smart-agent/cli.ts [options]
 *   npm run start:smart [-- options]
 *
 * Options:
 *   --config, -c <path>          YAML config file (default: smart-server.yaml if exists)
 *                                If path does not exist, writes a config template and exits.
 *   --secrets-dir <folder>       Secrets root (default: ~/.config/mcp-abap-adt/)
 *   --env                        Load *.env files from secrets-dir
 *   --env-path <file>            Load a specific .env file
 *   --port, -p <number>          HTTP port (default: 4004)
 *   --host <string>              Bind host (default: 0.0.0.0)
 *   --plugin-dir <path>          Additional plugin directory (loaded after defaults)
 *   --log-file <path>            Log file path (default: smart-server.log)
 *   --log-stdout                 Log to stdout instead of file
 *   --help, -h                   Show this help
 *   --version, -v                Print package version
 *
 * Secrets vs settings:
 *   Secrets (API keys) go in .env / secrets-dir, settings go in YAML config.
 *   Priority: YAML config > env vars > defaults.
 *   To disable MCP, omit the `mcp:` block or set `mcp.type: none` in YAML.
 *
 * YAML config example (smart-server.yaml):
 *   port: 4004
 *   llm:
 *     provider: deepseek
 *     apiKey: ${DEEPSEEK_API_KEY}
 *     model: deepseek-chat
 *   rag:
 *     type: in-memory
 *     embedder: ollama
 *     url: http://localhost:11434
 *     model: bge-m3
 *   mcp:
 *     type: http
 *     url: http://localhost:3000/mcp/stream/http
 *   log: smart-server.log
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  prefetchEmbedderFactories,
  prefetchRagFactories,
} from '@mcp-abap-adt/llm-agent-rag';
import { configDotenv } from 'dotenv';
import {
  generateConfigTemplate,
  loadYamlConfig,
  type ResolveConfigArgs,
  resolveSmartServerConfig,
} from './config.js';
import type { SmartServerConfig } from './smart-server.js';
import { SmartServer } from './smart-server.js';

// ---------------------------------------------------------------------------
// CLI arg parsing — must happen before dotenv so --env is available
// ---------------------------------------------------------------------------

function parseCliArgs() {
  try {
    return parseArgs({
      options: {
        config: { type: 'string', short: 'c' },
        'secrets-dir': { type: 'string' },
        env: { type: 'boolean' },
        'env-path': { type: 'string' },
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        'plugin-dir': { type: 'string' },
        'log-file': { type: 'string' },
        'log-stdout': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (err) {
    process.stderr.write(
      `${(err as Error).message}\nRun with --help for usage.\n`,
    );
    process.exit(1);
  }
}

const args = parseCliArgs();

if (args.version) {
  const pkg = JSON.parse(
    fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  process.stdout.write(`${pkg.name}@${pkg.version}\n`);
  process.exit(0);
}

if (args.help) {
  // Print the JSDoc comment at the top of this file as help text
  process.stdout.write(
    fs
      .readFileSync(new URL(import.meta.url), 'utf8')
      .match(/^(?:#![^\n]*\n)?\/\*\*([\s\S]*?)\*\//)?.[1]
      ?.replace(/^[ \t]*\* ?/gm, '') ?? 'See source for usage.\n',
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Load env — order: shell > --env-path > --env (*.env in secrets-dir) > .env
// All loads use override:false so shell-exported values always win.
// ---------------------------------------------------------------------------

const secretsDir =
  (args['secrets-dir'] as string | undefined) ??
  path.join(os.homedir(), '.config', 'mcp-abap-adt');
const envPath = args['env-path'] as string | undefined;
const envScan = args.env === true;

if (envPath) {
  const result = configDotenv({ path: path.resolve(envPath), override: false });
  if (!result.parsed) {
    process.stderr.write(`Warning: could not load env file: ${envPath}\n`);
  }
}
if (envScan) {
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(secretsDir)
      .filter((f) => f.endsWith('.env'))
      .sort();
  } catch {
    process.stderr.write(`Warning: secrets-dir not readable: ${secretsDir}\n`);
  }
  for (const f of entries) {
    const full = path.join(secretsDir, f);
    const result = configDotenv({ path: full, override: false });
    if (!result.parsed) {
      process.stderr.write(`Warning: could not load env file: ${full}\n`);
    }
  }
}
if (!envPath && !envScan) {
  // Implicit .env in cwd — only when neither flag is given. ok if absent.
  configDotenv({ path: path.resolve('.env'), override: false });
}

// ---------------------------------------------------------------------------
// Test escape-hatch: print requested env var(s) and exit.
// Activated by __CLI_PRINT_ENV=VAR1,VAR2 — test-only, never set in production.
// ---------------------------------------------------------------------------

if (process.env.__CLI_PRINT_ENV) {
  for (const name of process.env.__CLI_PRINT_ENV
    .split(',')
    .map((s) => s.trim())) {
    process.stdout.write(`${name}=${process.env[name] ?? ''}\n`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Config file: template generation or loading
// ---------------------------------------------------------------------------

const configArg = args.config as string | undefined;
const DEFAULT_CONFIG_FILE = 'smart-server.yaml';

// If --config given but file does not exist → generate template and exit
if (configArg && !fs.existsSync(configArg)) {
  generateConfigTemplate(configArg);
  process.stderr.write(
    `Created config template: ${configArg}\nEdit it and run llm-agent again.\n`,
  );
  process.exit(0);
}

// No --config and no smart-server.yaml in cwd → generate default template and exit
if (!configArg && !fs.existsSync(DEFAULT_CONFIG_FILE)) {
  generateConfigTemplate(DEFAULT_CONFIG_FILE);
  process.stderr.write(
    `No config file found. Created ${DEFAULT_CONFIG_FILE} with defaults.\n` +
      `Put your API keys in .env, adjust settings in ${DEFAULT_CONFIG_FILE}, then run llm-agent again.\n`,
  );
  process.exit(0);
}

// Load config file (explicit path or auto-detected default)
const configPath = configArg ?? DEFAULT_CONFIG_FILE;
const yaml = loadYamlConfig(path.resolve(configPath));

// ---------------------------------------------------------------------------
// Merge: CLI > YAML > env vars > defaults
// ---------------------------------------------------------------------------

let baseConfig: Omit<SmartServerConfig, 'log'>;
try {
  baseConfig = resolveSmartServerConfig(
    args as ResolveConfigArgs,
    yaml,
    process.env,
    { configPath: path.resolve(configPath) },
  );
} catch (err) {
  process.stderr.write(`Error: ${String(err)}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Logger: file or stdout
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: nested yaml access
const yamlAny = yaml as any;
const logToStdout = args['log-stdout'] === true;
const logFile = logToStdout
  ? null
  : (args['log-file'] ??
    yamlAny?.log ??
    process.env.LOG_FILE ??
    'smart-server.log');

let logStream: fs.WriteStream | null = null;
if (logFile) {
  logStream = fs.createWriteStream(logFile as string, { flags: 'a' });
}

const config: SmartServerConfig = {
  ...baseConfig,
  log: (event) => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
    if (logStream) {
      logStream.write(line);
    } else {
      process.stdout.write(line);
    }
  },
};

// ---------------------------------------------------------------------------
// Prefetch embedder peer packages — fails fast if a named peer is missing
// ---------------------------------------------------------------------------

{
  const ragCfg = baseConfig.rag;
  const embedderNames = new Set<string>();
  const pushEmbedderFor = (cfg: { type?: string; embedder?: string }): void => {
    if (cfg.type && cfg.type !== 'in-memory') {
      embedderNames.add(cfg.embedder ?? 'ollama');
    } else if (cfg.embedder) {
      // in-memory + explicit embedder upgrades to VectorRag — still needs the peer
      embedderNames.add(cfg.embedder);
    }
  };
  if (ragCfg) pushEmbedderFor(ragCfg);
  // Pipeline mode: each `pipeline.rag.{name}` entry can declare its own embedder
  const pipelineRag = (
    baseConfig as { pipeline?: { rag?: Record<string, unknown> } }
  ).pipeline?.rag;
  if (pipelineRag) {
    for (const cfg of Object.values(pipelineRag)) {
      if (cfg && typeof cfg === 'object')
        pushEmbedderFor(cfg as { type?: string; embedder?: string });
    }
  }
  await prefetchEmbedderFactories([...embedderNames]);
}

// ---------------------------------------------------------------------------
// Prefetch RAG backend peer packages — fails fast if a named peer is missing
// ---------------------------------------------------------------------------

{
  const ragCfg = baseConfig.rag;
  const ragBackendNames = new Set<string>();
  const peerBackend = (t: string | undefined): t is string =>
    t === 'qdrant' || t === 'hana-vector' || t === 'pg-vector';
  if (ragCfg && peerBackend(ragCfg.type)) ragBackendNames.add(ragCfg.type);
  const pipelineRag = (
    baseConfig as {
      pipeline?: { rag?: Record<string, { type?: string }> };
    }
  ).pipeline?.rag;
  if (pipelineRag) {
    for (const cfg of Object.values(pipelineRag)) {
      if (cfg?.type && peerBackend(cfg.type)) ragBackendNames.add(cfg.type);
    }
  }
  await prefetchRagFactories([...ragBackendNames]);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = new SmartServer(config);
const handle = await server.start();

process.stderr.write(`llm-agent listening on http://0.0.0.0:${handle.port}\n`);
if (logFile) process.stderr.write(`logs → ${logFile}\n`);
