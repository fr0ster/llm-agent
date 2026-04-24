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
 *   --env <path>                 .env file to load (default: .env in cwd if exists)
 *   --config <path>              YAML config file (default: smart-server.yaml if exists)
 *                                If path does not exist, writes a config template and exits.
 *   --port <number>              HTTP port (default: 4004)
 *   --host <string>              Bind host (default: 0.0.0.0)
 *   --llm-api-key <key>          DeepSeek API key
 *   --llm-model <model>          DeepSeek model (default: deepseek-chat)
 *   --llm-temperature <n>        Temperature 0..2 (default: 0.7)
 *   --rag-type <type>            ollama | in-memory (default: ollama)
 *   --rag-url <url>              Ollama URL (default: http://localhost:11434)
 *   --rag-model <model>          Embed model (default: nomic-embed-text)
 *   --rag-vector-weight <n>      Semantic similarity weight 0..1 (default: 0.7)
 *   --rag-keyword-weight <n>     Lexical matching weight 0..1 (default: 0.3)
 *   --mcp-type <type>            http | stdio (default: http if --mcp-url set)
 *   --mcp-url <url>              MCP HTTP endpoint
 *   --mcp-command <cmd>          MCP stdio command
 *   --mcp-args <args>            MCP stdio args (space-separated string)
 *   --mode <mode>                smart | passthrough | hybrid (default: hybrid)
 *                                  smart       — all requests via SmartAgent (RAG tool selection)
 *                                  passthrough — all requests directly to LLM (no agent)
 *                                  hybrid      — Cline → passthrough, others → SmartAgent
 *   --prompt-system <text>       System preamble for ContextAssembler
 *   --prompt-classifier <text>   Override classifier system prompt
 *   --agent-show-reasoning       Instruct the agent to explain its strategy
 *   --plugin-dir <path>          Additional plugin directory (loaded after defaults)
 *   --log-file <path>            Log file path (default: smart-server.log)
 *   --log-stdout                 Log to stdout instead of file
 *   --help                       Show this help
 *
 * Secrets vs settings:
 *   Secrets (API keys) go in .env, settings go in YAML config.
 *   Priority: CLI args > YAML config > env vars (.env + process env) > defaults.
 *
 * YAML config example (smart-server.yaml):
 *   port: 4004
 *   llm:
 *     apiKey: ${DEEPSEEK_API_KEY}   # resolved from .env
 *     model: deepseek-chat
 *   rag:
 *     type: ollama
 *     url: http://localhost:11434
 *     model: nomic-embed-text
 *   mcp:
 *     type: http
 *     url: http://localhost:3000/mcp/stream/http
 *   prompts:
 *     system: "You are a helpful assistant specialized in SAP ABAP development."
 *     classifier: null   # use default classifier prompt
 *   log: smart-server.log
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { configDotenv } from 'dotenv';
import {
  generateConfigTemplate,
  loadYamlConfig,
  type ResolveConfigArgs,
  resolveSmartServerConfig,
} from './config.js';
import { prefetchEmbedderFactories } from './embedder-factories.js';
import { prefetchRagFactories } from './rag-factories.js';
import type { SmartServerConfig } from './smart-server.js';
import { SmartServer } from './smart-server.js';

// ---------------------------------------------------------------------------
// CLI arg parsing — must happen before dotenv so --env is available
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    env: { type: 'string' },
    config: { type: 'string', short: 'c' },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    'llm-api-key': { type: 'string' },
    'llm-model': { type: 'string' },
    'llm-temperature': { type: 'string' },
    'rag-type': { type: 'string' },
    'rag-url': { type: 'string' },
    'rag-model': { type: 'string' },
    'rag-vector-weight': { type: 'string' },
    'rag-keyword-weight': { type: 'string' },
    'mcp-type': { type: 'string' },
    'mcp-url': { type: 'string' },
    'mcp-command': { type: 'string' },
    'mcp-args': { type: 'string' },
    mode: { type: 'string' },
    'prompt-system': { type: 'string' },
    'prompt-classifier': { type: 'string' },
    'agent-show-reasoning': { type: 'boolean' },
    'plugin-dir': { type: 'string' },
    'log-file': { type: 'string' },
    'log-stdout': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
  allowPositionals: false,
  strict: false,
});

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
// Load .env — explicit --env path, or .env in cwd if it exists
// ---------------------------------------------------------------------------

const envArg = args.env as string | undefined;
if (envArg) {
  const result = configDotenv({ path: path.resolve(envArg) });
  if (!result.parsed) {
    process.stderr.write(`Warning: could not load env file: ${envArg}\n`);
  }
} else {
  // Silently try .env in cwd; ok if it doesn't exist
  configDotenv({ path: path.resolve('.env') });
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
  const embedderNames: string[] = [];
  if (ragCfg && ragCfg.type !== 'in-memory') {
    // Explicit embedder override takes priority; otherwise derive from RAG type
    const name =
      ragCfg.embedder ?? (ragCfg.type === 'openai' ? 'openai' : 'ollama');
    embedderNames.push(name);
  }
  await prefetchEmbedderFactories(embedderNames);
}

// ---------------------------------------------------------------------------
// Prefetch RAG backend peer packages — fails fast if a named peer is missing
// ---------------------------------------------------------------------------

{
  const ragCfg = baseConfig.rag;
  const ragBackendNames: string[] = [];
  if (
    ragCfg &&
    (ragCfg.type === 'qdrant' ||
      ragCfg.type === 'hana-vector' ||
      ragCfg.type === 'pg-vector')
  ) {
    ragBackendNames.push(ragCfg.type);
  }
  await prefetchRagFactories(ragBackendNames);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = new SmartServer(config);
const handle = await server.start();

process.stderr.write(`llm-agent listening on http://0.0.0.0:${handle.port}\n`);
if (logFile) process.stderr.write(`logs → ${logFile}\n`);
