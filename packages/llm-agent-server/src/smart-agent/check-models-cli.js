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
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { configDotenv } from 'dotenv';
import { parse as parseYaml } from 'yaml';
configDotenv({ path: path.resolve('.env') });
const { values: args, positionals } = parseArgs({
    options: {
        config: { type: 'string', short: 'c' },
        delay: { type: 'string', short: 'd' },
        help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
});
if (args.help) {
    process.stdout.write('Usage: llm-agent-check [model1 ...] [--config <yaml>] [--delay <ms>]\n\n' +
        '  No arguments             Check ALL models from SAP AI Core catalog\n' +
        '  model1 model2            Check only specified models\n' +
        '  --config <yaml>  -c      Check models from pipeline YAML config\n' +
        '  --delay <ms>     -d      Delay between checks (default: 2000)\n');
    process.exit(0);
}
const delayMs = Number(args.delay ?? 2000);
const requestedModels = positionals;
const configPath = args.config;
function resolveEnv(value) {
    return value.replace(/\$\{([^:}]+)(?::-(.*?))?\}/g, (_, name, fallback) => process.env[name] ?? fallback ?? '');
}
function extractModelsFromYaml(yamlPath) {
    if (!fs.existsSync(yamlPath)) {
        process.stderr.write(`Config file not found: ${yamlPath}\n`);
        process.exit(1);
    }
    // biome-ignore lint/suspicious/noExplicitAny: yaml structure
    const yaml = parseYaml(fs.readFileSync(yamlPath, 'utf8'));
    const entries = [];
    // Pipeline LLM models (pipeline.llm.main/classifier/helper)
    if (yaml.pipeline?.llm) {
        for (const [role, cfg] of Object.entries(yaml.pipeline.llm)) {
            if (cfg?.model) {
                entries.push({ role, model: resolveEnv(String(cfg.model)) });
            }
        }
    }
    // Simple LLM config (llm.model)
    if (yaml.llm?.model && entries.length === 0) {
        entries.push({ role: 'main', model: resolveEnv(String(yaml.llm.model)) });
    }
    // RAG embedder models
    if (yaml.pipeline?.rag) {
        for (const [store, cfg] of Object.entries(yaml.pipeline.rag)) {
            if (cfg?.model) {
                entries.push({
                    role: `embedder:${store}`,
                    model: resolveEnv(String(cfg.model)),
                });
            }
        }
    }
    else if (yaml.rag?.model) {
        entries.push({
            role: 'embedder',
            model: resolveEnv(String(yaml.rag.model)),
        });
    }
    return entries;
}
// ---------------------------------------------------------------------------
// Fetch model catalog from SAP AI Core
// ---------------------------------------------------------------------------
async function fetchAllModels() {
    try {
        const { ScenarioApi } = await import('@sap-ai-sdk/ai-api');
        const resourceGroup = process.env.SAP_AI_RESOURCE_GROUP || 'default';
        const result = await ScenarioApi.scenarioQueryModels('foundation-models', {
            'AI-Resource-Group': resourceGroup,
        }).execute();
        // biome-ignore lint/suspicious/noExplicitAny: SDK response shape
        const resources = result.resources;
        return resources.map((r) => r.model).sort();
    }
    catch (err) {
        process.stderr.write(`Failed to fetch model catalog: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    }
}
async function checkLlm(model) {
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
    }
    catch (err) {
        return { ok: false, detail: extractError(err), ms: Date.now() - start };
    }
}
async function checkEmbedder(model) {
    const start = Date.now();
    try {
        const { OrchestrationEmbeddingClient } = await import('@sap-ai-sdk/orchestration');
        const client = new OrchestrationEmbeddingClient({
            embeddings: {
                model: {
                    name: model,
                },
            },
        });
        const response = await client.embed({ input: 'ping' });
        const embeddings = response.getEmbeddings();
        const dims = embeddings?.[0]?.embedding?.length ?? 0;
        return {
            ok: true,
            detail: `${dims} dimensions`,
            ms: Date.now() - start,
        };
    }
    catch (err) {
        return { ok: false, detail: extractError(err), ms: Date.now() - start };
    }
}
function extractError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    const statusMatch = msg.match(/status code (\d+)/);
    if (statusMatch)
        return `HTTP ${statusMatch[1]}`;
    // Capture nested cause
    // biome-ignore lint/suspicious/noExplicitAny: error inspection
    const cause = err?.cause?.message;
    if (cause)
        return `${msg.slice(0, 40)} — ${cause.slice(0, 40)}`;
    return msg.slice(0, 80);
}
async function checkModel(model, isEmbedder) {
    return isEmbedder ? checkEmbedder(model) : checkLlm(model);
}
let modelsToCheck;
let yamlEntries;
if (configPath) {
    yamlEntries = extractModelsFromYaml(configPath);
    // Deduplicate by model+type
    const seen = new Set();
    modelsToCheck = [];
    for (const e of yamlEntries) {
        const isEmbedder = e.role.startsWith('embedder');
        const key = `${e.model}:${isEmbedder}`;
        if (!seen.has(key)) {
            seen.add(key);
            modelsToCheck.push({ model: e.model, isEmbedder });
        }
    }
}
else if (requestedModels.length > 0) {
    modelsToCheck = requestedModels.map((m) => ({ model: m, isEmbedder: false }));
}
else {
    const catalogModels = await fetchAllModels();
    modelsToCheck = catalogModels.map((m) => ({ model: m, isEmbedder: false }));
}
if (configPath) {
    // Read provider from YAML to warn about non-SAP models
    const raw = parseYaml(fs.readFileSync(configPath, 'utf8'));
    const pipeline = raw.pipeline;
    const llmConfig = pipeline?.llm;
    const mainProvider = llmConfig?.main?.provider;
    const topProvider = raw.llm?.provider;
    const provider = mainProvider ?? topProvider;
    if (provider && provider !== 'sap-ai-sdk') {
        process.stderr.write(`\n  Warning: llm-agent-check uses SAP AI Core OrchestrationClient.\n` +
            `  Provider "${provider}" models are validated at startup via ILlm.chat() — no CLI check needed.\n\n`);
        process.exit(0);
    }
}
process.stdout.write(`\n  Checking ${modelsToCheck.length} model(s)...\n`);
process.stdout.write('  ─────────────────────────────────────────────────\n');
let passed = 0;
let failed = 0;
const results = [];
for (let i = 0; i < modelsToCheck.length; i++) {
    const { model, isEmbedder } = modelsToCheck[i];
    const result = await checkModel(model, isEmbedder);
    results.push({ model, ok: result.ok });
    if (result.ok)
        passed++;
    else
        failed++;
    const status = result.ok ? '\x1b[32m  OK  \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
    const ms = `${result.ms}ms`;
    const typeLabel = isEmbedder ? '[embed]' : '[llm]  ';
    process.stdout.write(`  ${typeLabel} ${model.padEnd(38)} ${status} ${ms.padStart(7)}  ${result.detail}\n`);
    if (i < modelsToCheck.length - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
    }
}
process.stdout.write('  ─────────────────────────────────────────────────\n');
if (yamlEntries) {
    process.stdout.write(`  Config: ${configPath}\n`);
    for (const entry of yamlEntries) {
        const res = results.find((r) => r.model === entry.model);
        const icon = res?.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
        process.stdout.write(`  ${entry.role.padEnd(18)} ${entry.model.padEnd(40)} ${icon}\n`);
    }
    process.stdout.write('  ─────────────────────────────────────────────────\n');
}
process.stdout.write(`  Total: ${modelsToCheck.length}  \x1b[32mOK: ${passed}\x1b[0m  \x1b[31mFAIL: ${failed}\x1b[0m\n\n`);
if (failed > 0)
    process.exit(1);
//# sourceMappingURL=check-models-cli.js.map