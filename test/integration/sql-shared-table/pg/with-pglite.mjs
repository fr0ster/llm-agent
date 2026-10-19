// One command: use PG_TEST_URL if set, else start PGlite, run run.mjs, stop it.
// Exit code is run.mjs's.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const run = (env) =>
  new Promise((done) =>
    spawn(process.execPath, [resolve(here, 'run.mjs')], {
      stdio: 'inherit',
      env,
    }).on('exit', (c) => done(c ?? 1)),
  );

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
