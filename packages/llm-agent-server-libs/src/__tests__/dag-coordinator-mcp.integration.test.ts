/**
 * Integration check (issue #159): the DAG coordinator dispatches MCP-tool-using
 * work to worker subagents — i.e. it does NOT exhibit #157, where the linear
 * coordinator's SelfDispatch runs a toolless `llm.chat()` and hallucinates.
 *
 * Migrated from the manual `scripts/integration/dag-coordinator-mcp/run.sh`.
 * The yaml configs (`smart-server-dag.yaml` + `abap-analyst.yaml`) are reused
 * verbatim — only the harness and assertions changed.
 *
 * ── Why NOT the `[SmartAgent: Executing <Tool>...]` content grep ────────────
 * As of commit 32db195, those liveness markers are flagged `ephemeral` and are
 * EXCLUDED from non-streaming (`stream:false`) content. The old run.sh grep
 * therefore no longer works in plain mode. This test asserts tool execution via
 * STRUCTURED signals instead, so it is mode-agnostic:
 *   (a) HTTP 200 + non-empty content
 *   (b) usage.prompt_tokens > 20000 — a grounding floor; a toolless
 *       hallucination spends ~1-2k, real MCP-grounded analysis spends tens of
 *       thousands
 *   (c) the DAG coordinator session trace exists under the config's logDir AND
 *       records real MCP tool execution (dag_stream chunks of kind mcp-call /
 *       mcp-result naming real tools, plus a dag_coordinator_final trace)
 *
 * ── Env gating (MUST skip cleanly in CI) ────────────────────────────────────
 * CI runs `npm run test --workspaces` with NO live services. This test SKIPS
 * (exit 0, not fail) unless ALL preconditions hold:
 *   - MCP_ENDPOINT reachable (probed via a short `tools/list` POST)
 *   - DEEPSEEK_API_KEY present (planner + worker LLM)
 *   - AICORE_SERVICE_KEY present (SAP AI Core embedder for tool-select)
 *
 * ── Server boot/teardown ────────────────────────────────────────────────────
 * We SPAWN the same entrypoint the manual script uses
 * (`packages/llm-agent-server/src/smart-agent/cli.ts` via tsx) as a child
 * process with its own process group, rather than importing SmartServer
 * in-process. Spawning mirrors the manual check exactly, exercises the real CLI
 * config + env-substitution path, and gives a clean kill (process group) on
 * teardown. The child's cwd is a fresh temp dir so the yaml's cwd-relative
 * `logDir: ./.run/sessions` lands at a path the test fully controls.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// repo-root/packages/llm-agent-server-libs/src/__tests__ → repo root
const REPO_ROOT = path.resolve(here, '../../../..');
const SCRIPT_DIR = path.join(
  REPO_ROOT,
  'scripts/integration/dag-coordinator-mcp',
);
const CONFIG = path.join(SCRIPT_DIR, 'smart-server-dag.yaml');
const CLI = path.join(
  REPO_ROOT,
  'packages/llm-agent-server/src/smart-agent/cli.ts',
);

const PORT = 4099;
const BASE = `http://localhost:${PORT}`;
const MCP_ENDPOINT =
  process.env.MCP_ENDPOINT ?? 'http://localhost:3001/mcp/stream/http';
const PROMPT =
  'Зроби аналіз пакету ZOK_BOOK_LIBRARY і вигрузи результат в файл маркдаун формату';

/** Short HTTP probe: is the MCP endpoint reachable and speaking JSON-RPC? */
async function mcpReachable(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
      signal: ctrl.signal,
    });
    // Any HTTP response (even 4xx) means something is listening and
    // speaking; a connection refusal throws below.
    return res.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Compute the skip reason (empty string ⇒ run). */
async function computeSkip(): Promise<string> {
  const missing: string[] = [];
  if (!process.env.DEEPSEEK_API_KEY) missing.push('DEEPSEEK_API_KEY');
  if (!process.env.AICORE_SERVICE_KEY) missing.push('AICORE_SERVICE_KEY');
  if (missing.length > 0) {
    return `missing env: ${missing.join(', ')}`;
  }
  if (!(await mcpReachable())) {
    return `MCP_ENDPOINT not reachable: ${MCP_ENDPOINT}`;
  }
  return '';
}

/** Recursively collect file paths under a dir (best-effort, never throws). */
function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let skipReason = '';
let child: import('node:child_process').ChildProcess | undefined;
let logSessionsDir = '';

before(async () => {
  skipReason = await computeSkip();
  if (skipReason) {
    // eslint-disable-next-line no-console
    console.error(`[#159] SKIP — ${skipReason}`);
    return;
  }

  // Run the child from REPO_ROOT so `tsx/esm` and the workspace packages resolve
  // (a temp cwd breaks Node's node_modules resolution → the CLI crashes at load).
  // The yaml writes cwd-relative `logDir: ./.run/sessions` → <repo>/.run/sessions;
  // clean it first so we read only THIS run's trace.
  logSessionsDir = path.join(REPO_ROOT, '.run', 'sessions');
  fs.rmSync(logSessionsDir, { recursive: true, force: true });
  fs.mkdirSync(logSessionsDir, { recursive: true });

  child = spawn(
    'node',
    ['--import', 'tsx/esm', CLI, '--config', CONFIG, '--port', String(PORT)],
    {
      cwd: REPO_ROOT,
      detached: true, // own process group → clean group-kill on teardown
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MCP_ENDPOINT,
        SMART_SERVER_PORT: String(PORT),
      },
    },
  );
  child.stdout?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));

  // Wait for HTTP readiness up to ~120s. ANY HTTP response means the server is
  // listening and routing — do NOT require 200: `/health` returns 503 for a
  // DAG-coordinator config (MCP lives in the worker, not at the coordinator, so
  // the server-level health check reports unhealthy) yet the server still
  // dispatches requests fine (the manual run.sh waited on the `server_started`
  // log line for the same reason).
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error('DAG server did not become ready within 120s');
    }
    try {
      await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      break; // any response (incl. 503) → the server is up and routing
    } catch {
      // not up yet (connection refused / timeout)
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
});

after(async () => {
  if (child?.pid) {
    try {
      // Kill the whole process group (tsx spawns children).
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }
});

describe('DAG-coordinator ↔ MCP integration (#159)', () => {
  it('dispatches MCP-tool-using work to a worker subagent (grounded, not toolless)', {
    timeout: 600_000,
  }, async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }

    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        stream: false,
        messages: [{ role: 'user', content: PROMPT }],
      }),
      signal: AbortSignal.timeout(590_000),
    });

    // (a) HTTP 200 + non-empty content.
    assert.equal(res.status, 200, `expected HTTP 200, got ${res.status}`);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content ?? '';
    assert.ok(content.length > 0, 'response content must be non-empty');

    // (b) Token grounding floor: real MCP-grounded analysis pulls tens of
    //     thousands of prompt tokens; a toolless hallucination spends ~1-2k.
    const promptTokens = body.usage?.prompt_tokens ?? 0;
    assert.ok(
      promptTokens > 20_000,
      `usage.prompt_tokens=${promptTokens} not > 20000 — looks toolless (#157 regression)`,
    );

    // (c) Structured trace: a DAG coordinator final trace exists AND real MCP
    //     tool executions are recorded (dag_stream mcp-call/mcp-result chunks).
    const files = walk(logSessionsDir);
    assert.ok(
      files.length > 0,
      `no session trace files under ${logSessionsDir}`,
    );

    const finalTrace = files.find((f) =>
      /dag_coordinator_final.*\.json$/.test(path.basename(f)),
    );
    assert.ok(
      finalTrace,
      `no *dag_coordinator_final*.json trace found under ${logSessionsDir}`,
    );

    // Scan dag_stream chunks for real MCP tool executions.
    const streamFiles = files.filter((f) =>
      /dag_stream.*\.json$/.test(path.basename(f)),
    );
    let toolHit: { tool: string; kind: string } | undefined;
    for (const f of streamFiles) {
      let chunk: { kind?: string; tool?: string };
      try {
        chunk = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        continue;
      }
      if (
        (chunk.kind === 'mcp-call' || chunk.kind === 'mcp-result') &&
        typeof chunk.tool === 'string' &&
        chunk.tool.length > 0
      ) {
        toolHit = { tool: chunk.tool, kind: chunk.kind };
        break;
      }
    }
    assert.ok(
      toolHit,
      `no mcp-call/mcp-result chunk naming a real tool found in ${streamFiles.length} dag_stream file(s) under ${logSessionsDir} — looks toolless (#157 regression)`,
    );

    // eslint-disable-next-line no-console
    console.error(
      `[#159] PASS — prompt_tokens=${promptTokens}, tool=${toolHit.tool} (${toolHit.kind}), trace=${path.basename(finalTrace)}`,
    );
  });
});
