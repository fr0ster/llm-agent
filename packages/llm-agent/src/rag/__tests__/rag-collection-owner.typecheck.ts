// packages/llm-agent/src/rag/__tests__/rag-collection-owner.typecheck.ts
// Compile-time assertions only: listed in tsconfig.typecheck.json, run by `npm run typecheck`.
// Each @ts-expect-error covers only the line below it, so every statement stays on one line.
// Every binding is exported: noUnusedLocals flags `_`-prefixed locals too (TS6133), and an
// unused-local error on a directive's line would keep the directive "used" after its guard is
// weakened — verified with tsc on these exact shapes: weakening the user arm yields TS2578 only
// when the bindings are exported.
import type {
  IRagProvider,
  IRagRegistry,
  RagCollectionOwner,
  RagCollectionRecord,
  RagCollectionScope,
  RagJsonValue,
} from '../../interfaces/rag.js';

declare const provider: IRagProvider;
declare const registry: IRagRegistry;
declare const wide: {
  scope: RagCollectionScope;
  sessionId?: string;
  userId?: string;
};

// the three shapes the union exists to admit
export const _owners: readonly RagCollectionOwner[] = [
  { scope: 'global' },
  { scope: 'user', userId: 'u' },
  { scope: 'session', sessionId: 's' },
];

// @ts-expect-error — a user owner without its key
export const _noUser: RagCollectionOwner = { scope: 'user' };
// @ts-expect-error — a session owner without its key
export const _noSession: RagCollectionOwner = { scope: 'session' };
// @ts-expect-error — the other scope's key does not stand in for this one
export const _wrongKey: RagCollectionOwner = { scope: 'user', sessionId: 's' };

// a record says whose it is, or it is not a record
// @ts-expect-error — no scope
export const _noScope: RagCollectionRecord = { storeName: 's', name: 'n' };
// biome-ignore format: one line — see the @ts-expect-error note above
export const _record: RagCollectionRecord = { storeName: 's', name: 'n', scope: 'user', userId: 'u', attributes: { roles: ['a'], n: 1, ok: true, none: null } };

// the old wide shape no longer type-checks on the way in, on either contract
// @ts-expect-error — IRagProvider.createCollection takes the owner union
void provider.createCollection('s', wide);
// @ts-expect-error — nor a literal missing its key
void provider.createCollection('s', { scope: 'session' });
// biome-ignore format: one line — see the @ts-expect-error note above
void provider.createCollection('s', { scope: 'user', userId: 'u', collectionName: 'n', attributes: { a: 1 }, adoptExisting: true });
// @ts-expect-error — IRagRegistry.createCollection takes the owner union too
void registry.createCollection({
  providerName: 'p',
  collectionName: 'c',
  scope: 'user',
});
// biome-ignore format: one line — see the @ts-expect-error note above
void registry.createCollection({ providerName: 'p', collectionName: 'c', scope: 'session', sessionId: 's', attributes: null });

// @ts-expect-error — a BigInt has no stored form common to the three backends
export const _big: RagJsonValue = 1n;
