import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveHanaModule } from '../hana-module.js';

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
