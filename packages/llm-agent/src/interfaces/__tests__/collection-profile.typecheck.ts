// Compile-time assertions only: listed in tsconfig.typecheck.json, run by `npm run typecheck`.
// Each @ts-expect-error covers only the line below it; every binding is exported (TS6133).
// Biome's line width is 80: each statement under a @ts-expect-error carries a
// `biome-ignore format` line above the directive, so the formatter never splits it
// and moves the error off the covered line (TS2578).
import type {
  RecordDraft,
  SharedItem,
  SharedItemsStores,
} from '../collection-profile.js';
import type { IRag } from '../rag.js';

export const _ok: RecordDraft = {
  text: 't',
  itemId: 'i',
  recordKind: 'full',
  owner: { scope: 'global' },
  metadata: { name: 'n' },
};
// biome-ignore format: one statement per @ts-expect-error line
// @ts-expect-error a record without an owner does not compile
export const _noOwner: RecordDraft = { text: 't', itemId: 'i', recordKind: 'full' };
// biome-ignore format: one statement per @ts-expect-error line
// @ts-expect-error extras cannot set itemId
export const _itemIdExtra: RecordDraft = { text: 't', itemId: 'i', recordKind: 'full', owner: { scope: 'global' }, metadata: { itemId: 'x' } };
// biome-ignore format: one statement per @ts-expect-error line
// @ts-expect-error extras cannot set visibility
export const _visibilityExtra: RecordDraft = { text: 't', itemId: 'i', recordKind: 'full', owner: { scope: 'global' }, metadata: { visibility: 'global' } };
// biome-ignore format: one statement per @ts-expect-error line
// @ts-expect-error a user owner needs its userId
export const _userNoId: RecordDraft = { text: 't', itemId: 'i', recordKind: 'full', owner: { scope: 'user' } };
// biome-ignore format: one statement per @ts-expect-error line
// @ts-expect-error extras cannot set staleRecordIds (F3)
export const _staleExtra: RecordDraft = { text: 't', itemId: 'i', recordKind: 'full', owner: { scope: 'global' }, metadata: { staleRecordIds: [] } };

declare const rag: IRag;
export const _userOnly: SharedItemsStores = { key: 'shared', user: rag };
export const _globalOnly: SharedItemsStores = { key: 'shared', global: rag };
// biome-ignore format: one statement per @ts-expect-error line
// @ts-expect-error neither user nor global
export const _neither: SharedItemsStores = { key: 'shared' };
// biome-ignore format: one statement per @ts-expect-error line
// @ts-expect-error a shared item cannot have session visibility
export const _sessionItem: SharedItem = { itemId: 'i', text: 't', visibility: { scope: 'session', sessionId: 's' } };
