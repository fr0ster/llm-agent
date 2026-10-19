import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticLogin } from '@mcp-abap-adt/llm-agent';
import { resolveHanaModule } from '../hana-module.js';
import { createHanaClient } from '../hana-vector-rag.js';

const createConnection = () => ({}) as never;

describe('resolveHanaModule', () => {
  it('resolves createConnection on default (CommonJS under ESM)', () => {
    const m = { default: { createConnection } };
    assert.equal(resolveHanaModule(m), m.default);
  });
  it('resolves a top-level createConnection', () => {
    const m = { createConnection };
    assert.equal(resolveHanaModule(m), m);
  });
  it('throws a clear error when neither exposes it', () => {
    assert.throws(
      () => resolveHanaModule({ default: {} }),
      /does not expose createConnection/,
    );
    assert.throws(() => resolveHanaModule(undefined), /createConnection/);
  });
});

describe('createHanaClient', () => {
  const cfg = {
    host: 'h',
    credential: staticLogin('u', 'p'),
    collectionName: 'c',
  };
  it('connects through resolveHanaModule: a CommonJS default export works', async () => {
    let connected = false;
    const conn = {
      connect: (_o: unknown, cb: (e: Error | null) => void) => {
        connected = true;
        cb(null);
      },
      exec: () => {},
      disconnect: () => {},
    };
    const client = await createHanaClient(cfg, async () => ({
      default: { createConnection: () => conn },
    }));
    assert.ok(connected);
    assert.equal(typeof client.query, 'function');
  });
  it('fails with the resolver error when the module has no createConnection', async () => {
    await assert.rejects(
      createHanaClient(cfg, async () => ({ default: {} })),
      /does not expose createConnection/,
    );
  });
});
