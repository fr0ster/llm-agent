#!/usr/bin/env node
/**
 * Manual live end-to-end check of the #171 external (client-provided) tool
 * round-trip under the DAG coordinator. Two legs, standard OpenAI tool-calling:
 *
 *   leg 1: POST /v1/chat/completions with a client `tools[]` (one external tool)
 *          → expect finish_reason:'tool_calls' carrying the external call with an
 *            `ext:` id (the worker surfaced it; it did NOT execute it).
 *   leg 2: append assistant(tool_calls) + a role:'tool' result (what a consumer /
 *          real MCP client would send back), re-POST with the same tools[]
 *          → expect a final assistant answer that USES the tool result.
 *
 * Prereqs (NOT for CI — live services):
 *   DEEPSEEK_API_KEY, AICORE_SERVICE_KEY, MCP at :3001.
 * Run:
 *   node --import tsx/esm --env-file=.env scripts/integration/dag-coordinator-mcp/roundtrip.mjs
 * (spawns its own DAG server on PORT; reads keys from --env-file/.env)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');
const CONFIG = join(here, 'smart-server-dag.yaml');
const CLI = join(REPO_ROOT, 'packages/llm-agent-server/src/smart-agent/cli.ts');
const PORT = 4080;
const BASE = `http://localhost:${PORT}`;
const MCP = process.env.MCP_ENDPOINT ?? 'http://localhost:3001/mcp/stream/http';

const EXTERNAL_TOOL = {
  type: 'function',
  function: {
    name: 'save_review',
    description:
      'Persist a finished review for the consumer. Call this once to save the review text; the consumer executes it and returns the saved record id.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'the review markdown' },
        collection: { type: 'string', description: 'target collection' },
      },
      required: ['content'],
    },
  },
};
const PROMPT =
  'Briefly review ABAP program ZDAZ_R_DELAYED_UPDATE (security + performance, ~4 bullets). Then PERSIST the review by calling the save_review tool with the review as `content` and collection="context". Do not finish until you have called save_review.';

async function post(messages) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      stream: false,
      messages,
      tools: [EXTERNAL_TOOL],
    }),
  });
  return res.json();
}

function waitReady() {
  const deadline = Date.now() + 120_000;
  return (async () => {
    for (;;) {
      if (Date.now() > deadline) throw new Error('server not ready in 120s');
      try {
        await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
        return;
      } catch {
        /* not up */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
}

const child = spawn(
  'node',
  ['--import', 'tsx/esm', CLI, '--config', CONFIG, '--port', String(PORT)],
  {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MCP_ENDPOINT: MCP, SMART_SERVER_PORT: String(PORT) },
  },
);
child.stdout.on('data', (d) => process.stderr.write(`[srv] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

try {
  await waitReady();
  console.log('\n===== LEG 1: prompt + external tool =====');
  const r1 = await post([{ role: 'user', content: PROMPT }]);
  const m1 = r1.choices?.[0]?.message ?? {};
  const fr1 = r1.choices?.[0]?.finish_reason;
  const calls = m1.tool_calls ?? [];
  console.log('finish_reason:', fr1);
  console.log('tool_calls:', JSON.stringify(calls, null, 2));
  console.log('prompt_tokens:', r1.usage?.prompt_tokens);

  const ext = calls.find((c) => (c.id ?? '').startsWith('ext:'));
  if (!ext) {
    console.log(
      '\nRESULT: ✗ no external ext: tool_call surfaced in leg 1 — see content:',
    );
    console.log((m1.content ?? '').slice(0, 800));
    throw new Error('leg1: external tool_call not surfaced');
  }
  console.log(`\nLEG 1 ✓ external call surfaced: ${ext.id} (${ext.function?.name})`);

  console.log('\n===== LEG 2: send tool result back (simulated consumer) =====');
  const toolResult = JSON.stringify({ ok: true, id: 'rev_42', collection: 'context' });
  const r2 = await post([
    { role: 'user', content: PROMPT },
    { role: 'assistant', content: m1.content ?? '', tool_calls: calls },
    { role: 'tool', tool_call_id: ext.id, content: toolResult },
  ]);
  const m2 = r2.choices?.[0]?.message ?? {};
  const fr2 = r2.choices?.[0]?.finish_reason;
  console.log('finish_reason:', fr2);
  console.log('prompt_tokens:', r2.usage?.prompt_tokens);
  console.log('final content (first 900 chars):\n', (m2.content ?? '').slice(0, 900));
  const usedResult = (m2.content ?? '').includes('rev_42') || fr2 === 'stop';
  console.log(
    `\nLEG 2 ${fr2 === 'stop' && (m2.content ?? '').length > 0 ? '✓ final answer returned' : '✗ no clean final answer'}` +
      (usedResult ? ' (mentions saved id / finished)' : ''),
  );
  console.log('\n===== DONE =====');
} finally {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* gone */
  }
}
