/**
 * Smart Server CLI
 *
 * Usage:
 *   node --import tsx/esm scripts/smart-server-cli.ts [options]
 *   npm run start:smart [-- options]
 *
 * Options:
 *   --config <path>          YAML config file (default: smart-server.yaml if exists)
 *   --port <number>          HTTP port (default: 3001)
 *   --host <string>          Bind host (default: 0.0.0.0)
 *   --llm-api-key <key>      DeepSeek API key
 *   --llm-model <model>      DeepSeek model (default: deepseek-chat)
 *   --llm-temperature <n>    Temperature 0..2 (default: 0.7)
 *   --rag-type <type>        ollama | in-memory (default: ollama)
 *   --rag-url <url>          Ollama URL (default: http://localhost:11434)
 *   --rag-model <model>      Embed model (default: nomic-embed-text)
 *   --mcp-type <type>        http | stdio (default: http if --mcp-url set)
 *   --mcp-url <url>          MCP HTTP endpoint
 *   --mcp-command <cmd>      MCP stdio command
 *   --mcp-args <args>        MCP stdio args (space-separated string)
 *   --log-file <path>        Log file path (default: smart-server.log)
 *   --log-stdout             Log to stdout instead of file
 *   --help                   Show this help
 *
 * All options can also be set via environment variables or a YAML config file.
 * Priority: CLI args > YAML config > env vars > defaults.
 *
 * YAML config example (smart-server.yaml):
 *   port: 3001
 *   llm:
 *     apiKey: ${DEEPSEEK_API_KEY}
 *     model: deepseek-chat
 *   rag:
 *     type: ollama
 *     url: http://localhost:11434
 *     model: nomic-embed-text
 *   mcp:
 *     type: http
 *     url: http://localhost:3000/mcp/stream/http
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import type { SmartServerConfig } from '../src/smart-agent/smart-server.js';
import { SmartServer } from '../src/smart-agent/smart-server.js';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    config:          { type: 'string',  short: 'c' },
    port:            { type: 'string',  short: 'p' },
    host:            { type: 'string' },
    'llm-api-key':   { type: 'string' },
    'llm-model':     { type: 'string' },
    'llm-temperature': { type: 'string' },
    'rag-type':      { type: 'string' },
    'rag-url':       { type: 'string' },
    'rag-model':     { type: 'string' },
    'mcp-type':      { type: 'string' },
    'mcp-url':       { type: 'string' },
    'mcp-command':   { type: 'string' },
    'mcp-args':      { type: 'string' },
    'log-file':      { type: 'string' },
    'log-stdout':    { type: 'boolean' },
    help:            { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
  strict: false,
});

if (args['help']) {
  // Print the JSDoc comment at the top of this file as help text
  process.stdout.write(fs.readFileSync(new URL(import.meta.url), 'utf8')
    .match(/^\/\*\*([\s\S]*?)\*\//)?.[1]
    ?.replace(/^\s*\* ?/gm, '') ?? 'See source for usage.\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// YAML config loading with ${ENV_VAR} substitution
// ---------------------------------------------------------------------------

function resolveEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(resolveEnvVars);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveEnvVars(v)]));
  }
  return value;
}

// biome-ignore lint/suspicious/noExplicitAny: YAML produces unknown structure
type YamlConfig = Record<string, any>;

function loadYaml(filePath: string): YamlConfig {
  const raw = fs.readFileSync(filePath, 'utf8');
  return resolveEnvVars(parseYaml(raw)) as YamlConfig;
}

// Auto-detect config file
const configPath = args['config'] ?? (fs.existsSync('smart-server.yaml') ? 'smart-server.yaml' : null);
const yaml: YamlConfig = configPath ? loadYaml(path.resolve(configPath)) : {};

// ---------------------------------------------------------------------------
// Merge: CLI > YAML > env vars > defaults
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: helper for nested get
const get = (obj: any, ...keys: string[]): any => keys.reduce((o, k) => o?.[k], obj);

const apiKey =
  args['llm-api-key'] ??
  get(yaml, 'llm', 'apiKey') ??
  process.env['DEEPSEEK_API_KEY'] ??
  '';

if (!apiKey) {
  process.stderr.write('Error: DeepSeek API key is required. Use --llm-api-key, YAML llm.apiKey, or DEEPSEEK_API_KEY env var.\n');
  process.exit(1);
}

const mcpUrl = args['mcp-url'] ?? get(yaml, 'mcp', 'url') ?? process.env['MCP_ENDPOINT'];
const mcpCommand = args['mcp-command'] ?? get(yaml, 'mcp', 'command') ?? process.env['MCP_COMMAND'];
const mcpType = (args['mcp-type'] ?? get(yaml, 'mcp', 'type') ?? (mcpUrl ? 'http' : mcpCommand ? 'stdio' : null)) as 'http' | 'stdio' | null;

const config: SmartServerConfig = {
  port: Number(args['port'] ?? get(yaml, 'port') ?? process.env['PORT'] ?? 3001),
  host: args['host'] ?? get(yaml, 'host') ?? '0.0.0.0',

  llm: {
    apiKey,
    model: args['llm-model'] ?? get(yaml, 'llm', 'model') ?? process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat',
    temperature: Number(args['llm-temperature'] ?? get(yaml, 'llm', 'temperature') ?? 0.7),
  },

  rag: {
    type: (args['rag-type'] ?? get(yaml, 'rag', 'type') ?? 'ollama') as 'ollama' | 'in-memory',
    url: args['rag-url'] ?? get(yaml, 'rag', 'url') ?? process.env['OLLAMA_URL'] ?? 'http://localhost:11434',
    model: args['rag-model'] ?? get(yaml, 'rag', 'model') ?? process.env['OLLAMA_EMBED_MODEL'] ?? 'nomic-embed-text',
  },

  mcp: mcpType
    ? {
        type: mcpType,
        url: mcpUrl,
        command: mcpCommand,
        args: (args['mcp-args'] ?? get(yaml, 'mcp', 'args'))
          ? String(args['mcp-args'] ?? get(yaml, 'mcp', 'args')).split(' ')
          : undefined,
      }
    : undefined,

  agent: {
    maxIterations: Number(get(yaml, 'agent', 'maxIterations') ?? 10),
    maxToolCalls:  Number(get(yaml, 'agent', 'maxToolCalls')  ?? 30),
    ragQueryK:     Number(get(yaml, 'agent', 'ragQueryK')     ?? 5),
  },
};

// ---------------------------------------------------------------------------
// Logger: file or stdout
// ---------------------------------------------------------------------------

const logToStdout = args['log-stdout'] === true;
const logFile = logToStdout
  ? null
  : (args['log-file'] ?? get(yaml, 'log') ?? process.env['LOG_FILE'] ?? 'smart-server.log');

let logStream: fs.WriteStream | null = null;
if (logFile) {
  logStream = fs.createWriteStream(logFile as string, { flags: 'a' });
}

config.log = (event) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  if (logStream) {
    logStream.write(line);
  } else {
    process.stdout.write(line);
  }
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = new SmartServer(config);
const handle = await server.start();

// Write startup info to stderr so it's always visible regardless of log config
process.stderr.write(`smart-server listening on http://0.0.0.0:${handle.port}\n`);
if (logFile) process.stderr.write(`logs → ${logFile}\n`);
