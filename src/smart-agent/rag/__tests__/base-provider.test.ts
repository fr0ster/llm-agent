import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IIdStrategy,
  IRag,
  IRagBackendWriter,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import { UnsupportedScopeError } from '../corrections/errors.js';
import { AbstractRagProvider } from '../providers/base-provider.js';
import {
  DirectEditStrategy,
  ImmutableEditStrategy,
} from '../strategies/edit/index.js';
import {
  GlobalUniqueIdStrategy,
  SessionScopedIdStrategy,
} from '../strategies/id/index.js';

const dummyWriter: IRagBackendWriter = {
  upsertRaw: async () => ({ ok: true, value: undefined }),
  deleteByIdRaw: async () => ({ ok: true, value: false }),
};
const dummyRag = { writer: () => dummyWriter } as unknown as IRag;

class TestProvider extends AbstractRagProvider {
  readonly name = 'test';
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  constructor(
    editable: boolean,
    supportedScopes: readonly RagCollectionScope[],
    idStrategyFactory?: (opts: {
      scope: RagCollectionScope;
      sessionId?: string;
    }) => IIdStrategy,
  ) {
    super();
    this.editable = editable;
    this.supportedScopes = supportedScopes;
    if (idStrategyFactory) this.idStrategyFactory = idStrategyFactory;
  }

  async createCollection(
    _name: string,
    opts: { scope: RagCollectionScope; sessionId?: string; userId?: string },
  ) {
    const check = this.checkScope(opts.scope);
    if (!check.ok) return check;
    const idStrategy = this.pickIdStrategy(opts);
    const editor = this.buildEditor(dummyRag, idStrategy);
    return { ok: true as const, value: { rag: dummyRag, editor } };
  }
}

describe('AbstractRagProvider.checkScope', () => {
  it('returns UnsupportedScopeError when scope not in supportedScopes', async () => {
    const p = new TestProvider(true, ['session']);
    const res = await p.createCollection('x', { scope: 'global' });
    assert.ok(!res.ok);
    assert.ok(res.error instanceof UnsupportedScopeError);
  });
  it('passes when scope is supported', async () => {
    const p = new TestProvider(true, ['session', 'global']);
    const res = await p.createCollection('x', { scope: 'global' });
    assert.ok(res.ok);
  });
});

describe('AbstractRagProvider.buildEditor', () => {
  it('returns DirectEditStrategy when editable', async () => {
    const p = new TestProvider(true, ['session']);
    const res = await p.createCollection('x', {
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(res.ok);
    assert.ok(res.value.editor instanceof DirectEditStrategy);
  });
  it('returns ImmutableEditStrategy when not editable', async () => {
    const p = new TestProvider(false, ['session']);
    const res = await p.createCollection('x', {
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(res.ok);
    assert.ok(res.value.editor instanceof ImmutableEditStrategy);
  });
});

describe('AbstractRagProvider.pickIdStrategy', () => {
  it('uses custom idStrategyFactory when provided', async () => {
    let called = false;
    const p = new TestProvider(true, ['session'], () => {
      called = true;
      return new GlobalUniqueIdStrategy();
    });
    const res = await p.createCollection('x', {
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(res.ok);
    assert.equal(called, true);
  });
});

// Keep referenced symbols
void SessionScopedIdStrategy;
