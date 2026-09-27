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
 *   A YAML config carries no secret — only `credentialRef: <REF>` names. This
 *   binary reads the account from the environment (.env / secrets-dir included)
 *   by one rule: <REF>_API_KEY, <REF>_SERVICE_KEY (SAP AI Core), or
 *   <REF>_USER + <REF>_PASSWORD. A section without credentialRef uses its role
 *   default: LLM (each llm: entry), RAG_STORE (rag.store and a qdrant skill
 *   store), RAG_EMBEDDER (rag.embedder). See the README's Credentials section.
 *   To disable MCP, omit the `mcp:` block or set `mcp.type: none` in YAML.
 *
 * YAML config example (smart-server.yaml):
 *   port: 4004
 *   llm:
 *     provider: deepseek
 *     model: deepseek-chat
 *     # credentialRef: DEEPSEEK       # omitted: reads LLM_API_KEY
 *   rag:
 *     store:
 *       type: in-memory
 *     embedder:
 *       provider: ollama
 *       url: http://localhost:11434
 *       model: bge-m3
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
import {
  generateConfigTemplate,
  loadYamlConfig,
  type ResolveConfigArgs,
  resolveSmartServerConfig,
  SmartServer,
  type SmartServerConfig,
} from '@mcp-abap-adt/llm-agent-server-libs';
import { configDotenv } from 'dotenv';
import {
  buildCompositionDeps,
  createModelResolver,
  legacyEnvHint,
} from '../composition/index.js';

// ---------------------------------------------------------------------------
// CLI arg parsing — must happen before dotenv so --env is available
// ---------------------------------------------------------------------------

/** An Error's own message — `String(err)` would print "Error: Error: …". */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  process.stderr.write(`Error: ${errorText(err)}\n`);
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
  // A relative `log:` names a directory that may not exist in the launch cwd
  // (the examples use ./.run/…); a stream opened into it errored
  // asynchronously, uncaught — and with sap-ai-sdk loaded, that SDK's handler
  // printed it to stdout. Create the directory, and fail loudly on stderr if
  // the log still cannot be written.
  fs.mkdirSync(path.dirname(path.resolve(logFile as string)), {
    recursive: true,
  });
  logStream = fs.createWriteStream(logFile as string, { flags: 'a' });
  logStream.on('error', (err) => {
    process.stderr.write(`Error: log file ${logFile}: ${err.message}\n`);
    process.exit(1);
  });
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
  // Only a built-in embedder has a peer package; a `factory` is the consumer's own,
  // registered in extraFactories rather than imported. A vector store with no
  // embedder section uses the ollama default, so its peer is needed too.
  const ragCfg = baseConfig.rag;
  const embedderNames = new Set<string>();
  if (ragCfg?.embedder) {
    if (ragCfg.embedder.factory === undefined)
      embedderNames.add(ragCfg.embedder.provider);
  } else if (ragCfg && ragCfg.store.type !== 'in-memory') {
    embedderNames.add('ollama');
  }
  await prefetchEmbedderFactories([...embedderNames]);
}

// ---------------------------------------------------------------------------
// Prefetch RAG backend peer packages — fails fast if a named peer is missing
// ---------------------------------------------------------------------------

{
  const storeType = baseConfig.rag?.store.type;
  const ragBackendNames =
    storeType === 'qdrant' ||
    storeType === 'hana-vector' ||
    storeType === 'pg-vector'
      ? [storeType]
      : [];
  await prefetchRagFactories(ragBackendNames);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// This binary is the composition root (§8 item 4): it owns the credentials and
// constructs every authenticated object through the seams the library no longer
// defaults — makeLlm, resolveEmbedder, makeRag, and buildSkillHost for the skill
// store's account — plus the model resolver PUT /v1/config needs.
//
// Caught here (rather than left to propagate) so a construction-time failure —
// a bad credentialRef, a missing apiBaseUrl — prints once to stderr and exits
// 1, matching every other startup failure in this file (see the config-resolve
// catch above). Left uncaught with provider sap-ai-sdk, the peer SDK that
// provider loads (@sap-ai-sdk/orchestration) registers its own process-wide
// winston exception handler, which intercepts it first and prints to stdout.
let handle: Awaited<ReturnType<SmartServer['start']>>;
try {
  const deps = buildCompositionDeps(process.env);
  const server = new SmartServer(
    {
      ...config,
      modelResolver:
        config.modelResolver ?? createModelResolver(deps.makeLlm, config.llm),
    },
    deps,
  );
  handle = await server.start();
} catch (err) {
  process.stderr.write(`Error: ${errorText(err)}\n`);
  const hint = legacyEnvHint(process.env, err);
  if (hint) process.stderr.write(`Hint: ${hint}\n`);
  process.exit(1);
}

process.stderr.write(
  `llm-agent listening on http://${config.host ?? '0.0.0.0'}:${handle.port}\n`,
);
if (logFile) process.stderr.write(`logs → ${logFile}\n`);
