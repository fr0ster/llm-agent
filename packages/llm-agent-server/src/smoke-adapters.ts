#!/usr/bin/env node

/**
 * Smoke test for Phase 2 adapters: LlmProviderBridge + LlmAdapter + McpClientAdapter
 *
 * Uses:
 *   - mcp-abap-adt (stdio, --env-path) for MCP
 *   - DeepSeek API for LLM
 *
 * Configuration:
 *   .env.smoke        — DEEPSEEK_API_KEY, ABAP_ENV_PATH
 *   .env.abap         — ABAP connection params for mcp-abap-adt
 *
 * Run:
 *   npm run smoke:adapters
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const smokeEnvPath = join(__dirname, '..', '.env.smoke');
if (!existsSync(smokeEnvPath)) {
  console.error(
    '❌ .env.smoke not found.\n   Copy .env.smoke.template → .env.smoke and fill in DEEPSEEK_API_KEY.',
  );
  process.exit(1);
}
config({ path: smokeEnvPath });

import { DeepSeekProvider } from '@mcp-abap-adt/deepseek-llm';
import type { Message } from '@mcp-abap-adt/llm-agent';
import { MCPClientWrapper } from './index.js';
import { LlmAdapter } from './smart-agent/adapters/llm-adapter.js';
import { LlmProviderBridge } from './smart-agent/adapters/llm-provider-bridge.js';
import { McpClientAdapter } from './smart-agent/adapters/mcp-client-adapter.js';

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

const deepseekKey = process.env.DEEPSEEK_API_KEY;
if (!deepseekKey) {
  console.error('❌ DEEPSEEK_API_KEY is not set in .env.smoke');
  process.exit(1);
}

const abapEnvRelPath = process.env.ABAP_ENV_PATH || '.env.abap';
const abapEnvAbsPath = join(__dirname, '..', abapEnvRelPath);
if (!existsSync(abapEnvAbsPath)) {
  console.error(
    `❌ ABAP env file not found: ${abapEnvAbsPath}\n   Copy .env.abap.template → .env.abap and fill in connection details.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function ok(label: string, detail?: string) {
  passed++;
  console.log(`  ✅ ${label}${detail ? `: ${detail}` : ''}`);
}

function fail(label: string, detail?: string) {
  failed++;
  console.error(`  ❌ ${label}${detail ? `: ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🔬 Phase 2 Adapter Smoke Test\n');
  console.log(
    `   LLM:  DeepSeek (${process.env.DEEPSEEK_MODEL || 'deepseek-chat'})`,
  );
  console.log(`   MCP:  mcp-abap-adt --env-path ${abapEnvAbsPath}`);
  console.log();

  // --- Setup ---
  const mcpClientWrapper = new MCPClientWrapper({
    transport: 'stdio',
    command: 'mcp-abap-adt',
    args: ['--env-path', abapEnvAbsPath],
  });

  const llmProvider = new DeepSeekProvider({
    apiKey: String(deepseekKey),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  });

  const llmAdapter = new LlmAdapter(new LlmProviderBridge(llmProvider), {
    model: llmProvider.model,
    getModels: () => llmProvider.getModels?.() ?? Promise.resolve([]),
    getEmbeddingModels: () =>
      llmProvider.getEmbeddingModels?.() ?? Promise.resolve([]),
  });
  const mcpAdapter = new McpClientAdapter(mcpClientWrapper);

  // --- Connect ---
  console.log('🔌 Connecting to MCP (mcp-abap-adt via stdio)...');
  try {
    await mcpClientWrapper.connect();
    ok('MCP connected');
  } catch (err) {
    fail('MCP connect', String(err));
    process.exit(1);
  }
  console.log();

  // -------------------------------------------------------------------------
  // Test 1: McpClientAdapter.listTools()
  // -------------------------------------------------------------------------
  console.log('Test 1: McpClientAdapter.listTools()');
  const toolsResult = await mcpAdapter.listTools();
  if (!toolsResult.ok) {
    fail('listTools', toolsResult.error.message);
    process.exit(1);
  }
  ok('listTools', `${toolsResult.value.length} tools`);
  for (const t of toolsResult.value.slice(0, 3)) {
    console.log(`     - ${t.name}`);
  }
  if (toolsResult.value.length > 3) {
    console.log(`     ... and ${toolsResult.value.length - 3} more`);
  }
  console.log();

  // -------------------------------------------------------------------------
  // Test 2: LlmAdapter.chat() — plain message
  // -------------------------------------------------------------------------
  console.log('Test 2: LlmAdapter.chat() — plain message (no tools)');
  const plainMessages: Message[] = [
    { role: 'user', content: 'Say hello in one sentence.' },
  ];
  const chatResult = await llmAdapter.chat(plainMessages);
  if (!chatResult.ok) {
    fail('chat plain', chatResult.error.message);
  } else {
    ok('chat plain', chatResult.value.finishReason);
    console.log(`     content: ${chatResult.value.content.slice(0, 80)}…`);
  }
  console.log();

  // -------------------------------------------------------------------------
  // Test 3: LlmAdapter.chat() — with tools from MCP
  // -------------------------------------------------------------------------
  console.log('Test 3: LlmAdapter.chat() — message with MCP tools');
  const toolMessages: Message[] = [
    {
      role: 'user',
      content: 'What ABAP tools do you have available? List them briefly.',
    },
  ];
  const chatToolsResult = await llmAdapter.chat(
    toolMessages,
    toolsResult.value,
  );
  if (!chatToolsResult.ok) {
    fail('chat with tools', chatToolsResult.error.message);
  } else {
    const tc = chatToolsResult.value.toolCalls ?? [];
    ok(
      'chat with tools',
      `finishReason=${chatToolsResult.value.finishReason}, toolCalls=${tc.length}`,
    );
    for (const c of tc) {
      console.log(`     - ${c.name}(${JSON.stringify(c.arguments)})`);
    }
    if (chatToolsResult.value.content) {
      console.log(
        `     content: ${chatToolsResult.value.content.slice(0, 80)}…`,
      );
    }
  }
  console.log();

  // -------------------------------------------------------------------------
  // Test 4: AbortSignal — already-aborted
  // -------------------------------------------------------------------------
  console.log('Test 4: LlmAdapter.chat() — pre-aborted signal');
  const controller = new AbortController();
  controller.abort();
  const abortResult = await llmAdapter.chat(
    [{ role: 'user', content: 'This should never reach DeepSeek.' }],
    undefined,
    { signal: controller.signal },
  );
  if (!abortResult.ok && abortResult.error.code === 'ABORTED') {
    ok('AbortSignal rejected with ABORTED');
  } else {
    fail(
      'AbortSignal',
      `expected ABORTED error, got: ${JSON.stringify(abortResult)}`,
    );
  }
  console.log();

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('─'.repeat(50));
  console.log(`  passed: ${passed}  failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
  console.log('✅ All smoke tests passed!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});
