import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MissingIdError } from '../corrections/errors.js';
import {
  CallerProvidedIdStrategy,
  CanonicalKeyIdStrategy,
  GlobalUniqueIdStrategy,
  SessionScopedIdStrategy,
} from '../strategies/id/index.js';

describe('CallerProvidedIdStrategy', () => {
  it('returns metadata.id when present', () => {
    const s = new CallerProvidedIdStrategy();
    assert.equal(s.resolve({ id: 'abc' }, 'text'), 'abc');
  });
  it('throws MissingIdError when id absent', () => {
    const s = new CallerProvidedIdStrategy();
    assert.throws(() => s.resolve({}, 'text'), MissingIdError);
  });
});

describe('GlobalUniqueIdStrategy', () => {
  it('returns metadata.id when present', () => {
    const s = new GlobalUniqueIdStrategy();
    assert.equal(s.resolve({ id: 'abc' }, 'text'), 'abc');
  });
  it('generates uuid when id absent', () => {
    const s = new GlobalUniqueIdStrategy();
    const id = s.resolve({}, 'text');
    assert.match(id, /^[0-9a-f-]{36}$/);
  });
});

describe('SessionScopedIdStrategy', () => {
  it('prefixes explicit id with session', () => {
    const s = new SessionScopedIdStrategy('sess-1');
    assert.equal(s.resolve({ id: 'x' }, 't'), 'sess-1:x');
  });
  it('falls back to canonicalKey', () => {
    const s = new SessionScopedIdStrategy('sess-1');
    assert.equal(s.resolve({ canonicalKey: 'doc' }, 't'), 'sess-1:doc');
  });
  it('generates session-scoped uuid when neither present', () => {
    const s = new SessionScopedIdStrategy('sess-1');
    const id = s.resolve({}, 't');
    assert.match(id, /^sess-1:[0-9a-f-]{36}$/);
  });
});

describe('CanonicalKeyIdStrategy', () => {
  it('uses canonicalKey with default version', () => {
    const s = new CanonicalKeyIdStrategy();
    assert.equal(s.resolve({ canonicalKey: 'doc' }, 't'), 'doc:v1');
  });
  it('uses provided version from metadata', () => {
    const s = new CanonicalKeyIdStrategy();
    assert.equal(s.resolve({ canonicalKey: 'doc', version: 3 }, 't'), 'doc:v3');
  });
  it('throws when canonicalKey missing', () => {
    const s = new CanonicalKeyIdStrategy();
    assert.throws(() => s.resolve({}, 't'), MissingIdError);
  });
});
