#!/usr/bin/env node
/**
 * llm-agent-check — Verify which SAP AI Core models actually respond.
 *
 * Usage:
 *   llm-agent-check                                    # check ALL models from SDK catalog
 *   llm-agent-check anthropic--claude-4.6-sonnet       # check one model
 *   llm-agent-check gpt-4o anthropic--claude-4.5-haiku # check specific models
 *   llm-agent-check --delay 5000                       # custom rate limit delay (ms)
 *
 * Sends a minimal chat request to each model and reports OK/FAIL.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';
import { configDotenv } from 'dotenv';

configDotenv({ path: path.resolve('.env') });

const { values: args, positionals } = parseArgs({
  options: {
    delay: { type: 'string', short: 'd' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
  strict: false,
});

if (args.help) {
  process.stdout.write(
    'Usage: llm-agent-check [model1 model2 ...] [--delay <ms>]\n\n' +
      '  No arguments    Check ALL models from SAP AI Core catalog\n' +
      '  model1 model2   Check only specified models\n' +
      '  --delay <ms>    Delay between checks (default: 2000)\n',
  );
  process.exit(0);
}

const delayMs = Number(args.delay ?? 2000);
const requestedModels = positionals as string[];

// ---------------------------------------------------------------------------
// Fetch model catalog from SAP AI Core
// ---------------------------------------------------------------------------

async function fetchAllModels(): Promise<string[]> {
  try {
    const { ScenarioApi } = await import('@sap-ai-sdk/ai-api');
    const resourceGroup = process.env.SAP_AI_RESOURCE_GROUP || 'default';
    const result = await ScenarioApi.scenarioQueryModels('foundation-models', {
      'AI-Resource-Group': resourceGroup,
    }).execute();

    // biome-ignore lint/suspicious/noExplicitAny: SDK response shape
    const resources = result.resources as any[];
    return resources.map((r) => r.model as string).sort();
  } catch (err) {
    process.stderr.write(
      `Failed to fetch model catalog: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Check a single model
// ---------------------------------------------------------------------------

async function checkModel(
  model: string,
): Promise<{ ok: boolean; detail: string; ms: number }> {
  const start = Date.now();
  try {
    const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
    const client = new OrchestrationClient({
      promptTemplating: {
        model: {
          name: model,
          params: { max_tokens: 10, temperature: 0 },
        },
        prompt: {
          template: [{ role: 'user', content: 'Reply with OK' }],
        },
      },
    });

    const response = await client.chatCompletion();
    const content = response.getContent() || '';
    return {
      ok: true,
      detail: content.trim().slice(0, 30),
      ms: Date.now() - start,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const statusMatch = msg.match(/status code (\d+)/);
    const status = statusMatch ? `HTTP ${statusMatch[1]}` : msg.slice(0, 80);
    return { ok: false, detail: status, ms: Date.now() - start };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const models =
  requestedModels.length > 0 ? requestedModels : await fetchAllModels();

process.stdout.write(`\n  Checking ${models.length} model(s)...\n`);
process.stdout.write('  ─────────────────────────────────────────────────\n');

let passed = 0;
let failed = 0;

for (const model of models) {
  const result = await checkModel(model);

  if (result.ok) passed++;
  else failed++;

  const status = result.ok ? '\x1b[32m  OK  \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
  const ms = `${result.ms}ms`;

  process.stdout.write(
    `  ${model.padEnd(42)} ${status} ${ms.padStart(7)}  ${result.detail}\n`,
  );

  // Rate limit delay between requests
  if (models.indexOf(model) < models.length - 1) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

process.stdout.write('  ─────────────────────────────────────────────────\n');
process.stdout.write(
  `  Total: ${models.length}  \x1b[32mOK: ${passed}\x1b[0m  \x1b[31mFAIL: ${failed}\x1b[0m\n\n`,
);

if (failed > 0) process.exit(1);
