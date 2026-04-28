/**
 * Smart Server Demo — Ollama Embeddings + DeepSeek + MCP
 *
 * Starts an OpenAI-compatible HTTP server on PORT (default: 3001).
 * ALL output goes to LOG_FILE — nothing is written to stdout/stderr so
 * stdio-based MCP transports work without interference.
 *
 * Endpoints:
 *   POST /v1/chat/completions  — OpenAI-compatible chat
 *   GET  /v1/usage             — accumulated token usage
 *
 * Configure via .env.smart-server (see scripts/.env.smart-server.template).
 */
import { configDotenv } from 'dotenv';

configDotenv({ path: '.env.smart-server' });

import fs from 'node:fs';
import { resolveSmartServerConfig } from '../src/smart-agent/config.js';
import { SmartServer } from '../src/smart-agent/smart-server.js';

// ---------------------------------------------------------------------------
// Logger — ALL output goes here, never stdout/stderr
// ---------------------------------------------------------------------------
const logPath = process.env.LOG_FILE ?? 'smart-server.log';
const logStream = fs.createWriteStream(logPath, { flags: 'a' });
const log = (event) =>
  logStream.write(
    `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
  );
// ---------------------------------------------------------------------------
// Config + start
// ---------------------------------------------------------------------------
let baseConfig;
try {
  baseConfig = resolveSmartServerConfig({}, {}, process.env);
} catch (err) {
  process.stderr.write(`Error: ${String(err)}\n`);
  process.exit(1);
}
await new SmartServer({ ...baseConfig, log }).start();
// IMPORTANT: nothing written to process.stdout — only to log file
//# sourceMappingURL=start-smart-server.js.map
