// packages/llm-agent-libs/src/collections/item-pool.ts
import type { ICandidatePool } from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';

/**
 * Items per source (spec §4.4): `n` when given, else the caller's k of the
 * (sub-)query — the generic default, which guesses no catalog size (D56, spec
 * §7.1). Every item has at most `m` records, so `items × m` records always hold
 * at least `items` distinct items. A deeper pool is the consumer's number.
 */
export class ItemPool implements ICandidatePool {
  readonly name = 'item-pool';
  constructor(private readonly n?: number) {
    if (n !== undefined) assertPositiveInteger('ItemPool', 'items', n);
  }
  items(requestedK: number): number {
    assertPositiveInteger('ItemPool', 'requestedK', requestedK);
    return this.n ?? requestedK;
  }
  recordsToFetch(requestedK: number, maxRecordsPerItem: number): number {
    assertPositiveInteger('ItemPool', 'maxRecordsPerItem', maxRecordsPerItem);
    return this.items(requestedK) * maxRecordsPerItem;
  }
}
