import { createHash } from 'node:crypto';

/** Deterministic content-hash id (the spec's `uuidv5(...)` realised without a
 *  new dependency - matches run-scope.ts's createHash usage). Segments are
 *  length-prefixed so no concatenation collision is possible
 *  (['a','bc'] and ['ab','c'] hash differently). */
export function deterministicId(...segments: (string | number)[]): string {
  const h = createHash('sha256');
  for (const s of segments) {
    const str = String(s);
    h.update(String(str.length));
    h.update(' ');
    h.update(str);
  }
  return h.digest('hex');
}
