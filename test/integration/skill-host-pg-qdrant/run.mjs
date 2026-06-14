#!/usr/bin/env node
// Lifecycle wrapper for the skill-host PG+Qdrant integration test.
// up --wait --build → verify baked model digest → bootstrap Qdrant collection →
// run the test via tsx under a HARD TIMEOUT in its own process group → ALWAYS
// `docker compose down -v` in a finally. No test logic lives here.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_TIMEOUT_MS = 5 * 60_000; // hard cap: a hung test/Ollama must not wedge teardown
const POST_KILL_GRACE_MS = 5_000;
// Authoritative manifest digest of the baked model (the bare hex `/api/tags`
// reports under models[].digest). run.mjs re-reads the SAME field and fails loud
// on drift.
const EXPECTED_MODEL_DIGEST = '0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

function fail(msg) {
  console.error(`\n[run.mjs] ${msg}`);
  process.exit(1);
}

// POSIX-only: this wrapper uses a detached process group + negative-PID group
// kill, unsupported on Windows. Declare the scope and bail clearly rather than
// half-work. (A Windows port would use `taskkill /T` — out of scope.)
if (process.platform === 'win32') {
  fail('this integration test is POSIX-only (uses process-group kill); run on Linux/macOS or in WSL.');
}

// Port contract: fixed defaults, each overridable by ONE env var, wired
// IDENTICALLY into compose (`${PG_TEST_PORT:-5432}:5432`) and the URLs below, so
// the published host port and the URL the test dials never disagree.
const PG_PORT = process.env.PG_TEST_PORT ?? '5432';
const QDRANT_PORT = process.env.QDRANT_TEST_PORT ?? '6333';
const OLLAMA_PORT = process.env.OLLAMA_TEST_PORT ?? '11434';

const env = {
  ...process.env,
  // re-export the ports so `docker compose` interpolates the SAME values
  PG_TEST_PORT: PG_PORT,
  QDRANT_TEST_PORT: QDRANT_PORT,
  OLLAMA_TEST_PORT: OLLAMA_PORT,
  PG_TEST_URL: `postgres://test:test@localhost:${PG_PORT}/skills`,
  PG_READ_TEST_URL: `postgres://readonly:readonly@localhost:${PG_PORT}/skills`,
  QDRANT_TEST_URL: `http://localhost:${QDRANT_PORT}`,
  QDRANT_TEST_COLLECTION: 'skills_test',
  EMBED_DIM: '768',
  OLLAMA_TEST_URL: `http://localhost:${OLLAMA_PORT}`,
  OLLAMA_TEST_MODEL: 'nomic-embed-text',
};

function compose(args, opts = {}) {
  return spawnSync('docker', ['compose', ...args], {
    cwd: here,
    stdio: 'inherit',
    env, // pass the port contract through to compose interpolation
    ...opts,
  });
}

// Preflight: docker compose must exist.
const probe = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' });
if (probe.status !== 0) {
  fail('docker compose is not available — this is an explicit, opt-in integration run.');
}

// Run the test async, detached into its OWN process group, under a hard timeout.
// spawnSync is unusable here: it blocks the event loop, so a timer could never
// fire and a hung child would wedge the wrapper forever. On timeout we escalate:
// SIGKILL the whole group (negative pid) so a stuck tsx/node/Ollama-waiting
// grandchild dies too; if that throws, fall back to killing the parent. We do NOT
// claim the child is guaranteed dead — we wait a BOUNDED grace for `close`, then
// resolve regardless (warning about a possible orphan) so the finally always
// reaches `down -v`, the authoritative container/volume cleanup.
function runTestWithTimeout() {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['tsx', '--test', 'test/integration/skill-host-pg-qdrant/skill-host.integration.test.ts'],
      { cwd: repoRoot, stdio: 'inherit', env, detached: true },
    );
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[run.mjs] test exceeded ${TEST_TIMEOUT_MS}ms — killing process group`);
      // (a) whole-group kill; (b) fallback to the parent. Neither may throw out.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      // Bounded wait for `close`; if it never comes, proceed anyway (orphan warning).
      setTimeout(() => {
        if (!settled) {
          console.error(
            '[run.mjs] WARNING: test did not exit after SIGKILL — a host-side orphan child/group may survive; continuing to teardown (down -v still cleans containers/volume).',
          );
          done(124);
        }
      }, POST_KILL_GRACE_MS);
    }, TEST_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return done(124); // conventional timeout exit code
      done(signal ? 1 : (code ?? 1));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[run.mjs] failed to spawn test: ${err.message}`);
      done(1);
    });
  });
}

let testStatus = 1;
try {
  console.log('[run.mjs] starting stack (first run builds the Ollama image)…');
  if (compose(['up', '-d', '--wait', '--build']).status !== 0) {
    compose(['logs']);
    fail('docker compose up --wait failed (see logs above).');
  }

  console.log('[run.mjs] verifying baked Ollama model digest via /api/tags…');
  const tags = await (await fetch(`${env.OLLAMA_TEST_URL}/api/tags`)).json();
  const model = (tags?.models ?? []).find((m) => m.name === `${env.OLLAMA_TEST_MODEL}:latest`);
  if (!model) fail(`model ${env.OLLAMA_TEST_MODEL}:latest not present in /api/tags`);
  if (model.digest !== EXPECTED_MODEL_DIGEST) {
    fail(`model digest drift: got ${model.digest}, expected ${EXPECTED_MODEL_DIGEST}`);
  }

  console.log('[run.mjs] bootstrapping Qdrant collection…');
  const put = await fetch(`${env.QDRANT_TEST_URL}/collections/${env.QDRANT_TEST_COLLECTION}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vectors: { size: Number(env.EMBED_DIM), distance: 'Cosine' } }),
  });
  if (!put.ok) fail(`Qdrant collection create failed: ${put.status}`);
  const got = await fetch(`${env.QDRANT_TEST_URL}/collections/${env.QDRANT_TEST_COLLECTION}`);
  const cfg = await got.json();
  const size = cfg?.result?.config?.params?.vectors?.size;
  if (size !== Number(env.EMBED_DIM)) {
    fail(`Qdrant collection has size ${size}, expected ${env.EMBED_DIM}`);
  }

  console.log('[run.mjs] running the integration test (hard timeout)…');
  testStatus = await runTestWithTimeout();
} finally {
  console.log('[run.mjs] tearing down (down -v)…');
  compose(['down', '-v']);
}

process.exit(testStatus);
