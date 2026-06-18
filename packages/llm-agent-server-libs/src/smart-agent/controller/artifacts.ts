import { createHash } from 'node:crypto';
import type { IKnowledgeRagHandle } from '@mcp-abap-adt/llm-agent';
import type { KnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import type { Step } from './types.js';

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

export const PLAN_DECISION_ARTIFACT = 'plan-decision';

/** PlanDecision is a DISCRIMINATED UNION by kind, so required key fields are
 *  type-enforced (a `page` MUST carry `tokenHash`, an `expand` MUST carry
 *  `discoveryStepId`+`offset`). `decisionId`/`slotId` are resolved on READ. */
export type PlanDecision = {
  steps: Step[];
  decisionId?: string;
  slotId?: string;
} & (
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
    }
);

/** The DecisionKey for slot/id computation. Fail-loud: a malformed decision
 *  (e.g. a `page` with no `tokenHash`) throws rather than hashing a '' field. */
function keyOf(d: PlanDecision): DecisionKey {
  switch (d.kind) {
    case 'create':
      return { kind: 'create', runId: d.runId };
    case 'replan':
      if ('anchor' in d)
        return { kind: 'replan', runId: d.runId, anchor: d.anchor };
      if ('triggerId' in d)
        return { kind: 'replan', runId: d.runId, triggerId: d.triggerId };
      throw new Error('plan-decision replan requires anchor or triggerId');
    case 'expand':
      if (d.discoveryStepId === undefined || d.offset === undefined)
        throw new Error(
          'plan-decision expand requires discoveryStepId + offset',
        );
      return {
        kind: 'expand',
        runId: d.runId,
        discoveryStepId: d.discoveryStepId,
        offset: d.offset,
      };
    case 'page':
      if (!d.tokenHash)
        throw new Error('plan-decision page requires tokenHash');
      return {
        kind: 'page',
        runId: d.runId,
        discoveryChainId: d.discoveryChainId,
        pageIndex: d.pageIndex,
        tokenHash: d.tokenHash,
      };
  }
}

export async function writePlanDecision(
  be: KnowledgeBackend,
  sessionId: string,
  d: PlanDecision,
  plannerOutput: string,
  nowIso: string,
  writeOrdinal: number,
): Promise<void> {
  const k = keyOf(d);
  await be.put(sessionId, {
    content: JSON.stringify({ steps: d.steps }),
    metadata: {
      traceId: sessionId,
      turnId: sessionId,
      stepperId: 'controller',
      task: 'controller',
      artifactType: PLAN_DECISION_ARTIFACT,
      runId: d.runId,
      kind: d.kind,
      slotId: decisionSlotId(k),
      decisionId: decisionId(k, plannerOutput),
      createdAt: nowIso,
      writeOrdinal,
    },
  });
}

/** Flat read-shape: the board's structure source needs only kind + steps + the
 *  resolved ids, NOT the kind-specific key fields (not stored on the artifact). */
export interface PlanDecisionRecord {
  runId: string;
  kind: DecisionKey['kind'];
  decisionId?: string;
  slotId?: string;
  steps: Step[];
}

export async function readPlanDecisions(
  rag: IKnowledgeRagHandle,
  runId: string,
): Promise<PlanDecisionRecord[]> {
  const list = await rag.list({ runId, artifactType: PLAN_DECISION_ARTIFACT });
  return list.map((e) => ({
    runId,
    kind: (e.metadata.kind ?? 'create') as DecisionKey['kind'],
    decisionId: e.metadata.decisionId,
    slotId: e.metadata.slotId,
    steps: (JSON.parse(e.content) as { steps: Step[] }).steps,
  }));
}
