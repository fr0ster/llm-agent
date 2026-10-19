// Serves an in-memory PGlite (Postgres in WASM) with pgvector over TCP, so
// the ordinary `pg` driver can connect. Usage: node serve-pglite.mjs [port]
// Prints `PG_TEST_URL=<url>` once ready and keeps running until killed.
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.argv[2] ?? process.env.PGLITE_PORT ?? 54329);
const db = await PGlite.create({ extensions: { vector } });
const server = new PGLiteSocketServer({
  db,
  port,
  host: '127.0.0.1',
  maxConnections: 20,
});
await server.start();
console.log(
  `PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
