// Use PG_TEST_URL if set, otherwise start PGlite; run shared-layout and access tests.
// Return the first failing suite exit code and stop the managed server.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runShared = (env) =>
  new Promise((done) =>
    spawn(process.execPath, [resolve(here, 'run.mjs')], {
      stdio: 'inherit',
      env,
    }).on('exit', (c) => done(c ?? 1)),
  );

async function run(env) {
  const sharedCode = await runShared(env);
  if (sharedCode !== 0) return sharedCode;
  return new Promise((done) =>
    spawn(process.execPath, [
      '--import', 'tsx/esm', '--test', '--test-concurrency=1', '--test-reporter=spec',
      'packages/pg-vector-rag/src/__tests__/rag-access-store-conformance.test.ts',
      'packages/pg-vector-rag/src/__tests__/migrate-access.test.ts',
      'packages/pg-vector-rag/src/__tests__/owner-query.test.ts',
    ], { cwd: resolve(here, '../../../..'), stdio: 'inherit', env }).on('exit', c => done(c ?? 1)),
  );
}

if (process.env.PG_TEST_URL) {
  process.exit(await run(process.env));
}
const server = spawn(process.execPath, [resolve(here, 'serve-pglite.mjs')], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const url = await new Promise((ok, fail) => {
  let buf = '';
  server.stdout.on('data', (d) => {
    buf += d;
    const m = buf.match(/PG_TEST_URL=(\S+)/);
    if (m) ok(m[1]);
  });
  server.on('exit', () => fail(new Error('PGlite server exited early')));
});
console.log(`PGlite serving ${url}`);
let code = 1;
try {
  code = await run({ ...process.env, PG_TEST_URL: url });
} finally {
  server.kill('SIGTERM');
}
process.exit(code);
