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

export type DecisionKey =
  | { kind: 'create'; runId: string }
  | { kind: 'replan'; runId: string; anchor: string }
  | { kind: 'replan'; runId: string; triggerId: string }
  | { kind: 'expand'; runId: string; discoveryStepId: string; offset: number }
  | {
      kind: 'page';
      runId: string;
      discoveryChainId: string;
      pageIndex: number;
      tokenHash: string;
    };

/** Slot the decision occupies (one winner per slot, §F). */
export function decisionSlotId(k: DecisionKey): string {
  switch (k.kind) {
    case 'create':
      return deterministicId(k.runId, 'create');
    case 'replan':
      return 'anchor' in k
        ? deterministicId(k.runId, 'replan', 'anchor', k.anchor)
        : deterministicId(k.runId, 'replan', 'trigger', k.triggerId);
    case 'expand':
      return deterministicId(k.runId, 'expand', k.discoveryStepId, k.offset);
    case 'page':
      return deterministicId(k.runId, 'page', k.discoveryChainId, k.pageIndex);
  }
}

/** Content-hash decision id. LLM-authored kinds fold `plannerOutput` (identical
 *  output → identical id → dedup; differing → different id). The controller-
 *  authored `page` is deterministic from its key fields + tokenHash (no
 *  plannerOutput). (§F: at-least-once invocation, exactly-once applied effect.) */
export function decisionId(k: DecisionKey, plannerOutput: string): string {
  switch (k.kind) {
    case 'create':
      return deterministicId(k.runId, 'create', plannerOutput);
    case 'replan':
      return 'anchor' in k
        ? deterministicId(k.runId, 'replan', 'anchor', k.anchor, plannerOutput)
        : deterministicId(
            k.runId,
            'replan',
            'trigger',
            k.triggerId,
            plannerOutput,
          );
    case 'expand':
      return deterministicId(
        k.runId,
        'expand',
        k.discoveryStepId,
        k.offset,
        plannerOutput,
      );
    case 'page':
      return deterministicId(
        k.runId,
        'page',
        k.discoveryChainId,
        k.pageIndex,
        k.tokenHash,
      );
  }
}
