import type { LlmUsage } from '@mcp-abap-adt/llm-agent';
import { extractJsonObject } from './controller-coordinator-handler.js';
import type { Outcome } from './outcome.js';
import { appendHint } from './prompts.js';
import type { ISubagentClient } from './subagent-client.js';
import type { Step } from './types.js';

/** One reference's evidence: the closest stored artifact's content (or none). */
export interface Evidence {
  ref: string;
  hit: boolean;
  topArtifact?: string;
}

export interface ReviewOpts {
  hint?: string;
  logUsage?: (role: string, u?: LlmUsage) => void;
}

/** The reviewer's return: EITHER an authoritative step Outcome (incl. a genuine
 *  `failed` verdict → step replan), OR a judge-failure — the reviewer could not
 *  produce a verdict (provider error / malformed / contradictory ok-with-empty).
 *  The controller treats these differently: a judge-failure is re-asked within
 *  maxReviewRetries and, on exhaustion, ABORTS the run — it is NEVER mapped to a
 *  step `failed`/replan. */
export type ReviewResult =
  | { kind: 'outcome'; outcome: Outcome }
  | { kind: 'judge-failure'; reason: string };

/** Separate judging role. The controller depends ONLY on this; `status` always
 *  comes through a well-formed Outcome. Default impl is LLM-backed; swappable. */
export interface IReviewer {
  review(
    step: Step,
    evidence: readonly Evidence[],
    executorResult: string,
    opts: ReviewOpts,
  ): Promise<ReviewResult>;
}

const REVIEWER_SYSTEM =
  'You are the reviewer. You did NOT do the work — you JUDGE it. Given the ' +
  "step intent, the per-reference evidence, and the executor's result, decide " +
  'the authoritative outcome and return a SINGLE JSON object: ' +
  '{"status":"ok"|"exists"|"failed"|"partial","approved":<content to keep>,' +
  '"remainder":<what is still missing>,"note":<short reason>}. ' +
  'Use "ok" when the step is fully satisfied, "exists" when the target already ' +
  'existed (idempotent no-op success), "partial" when only part is done (put the ' +
  'accepted content in "approved" and what remains in "remainder"), "failed" when ' +
  'the result does not satisfy the step. "approved" MUST be non-empty for ok/' +
  'exists/partial. Judge ONLY from the evidence + result; do NOT invent facts. ' +
  'The evidence lists, per required reference, the CLOSEST stored artifact (or ' +
  'MISSING). Decide for YOURSELF whether that artifact actually satisfies the ' +
  'reference — a closest-match artifact may be irrelevant; treat an unsatisfied or ' +
  'missing required reference as "failed" (note: "missing input: <ref>"). ' +
  'Output JSON only.';

export class LlmReviewer implements IReviewer {
  constructor(private readonly client: ISubagentClient) {}

  async review(
    step: Step,
    evidence: readonly Evidence[],
    executorResult: string,
    opts: ReviewOpts,
  ): Promise<ReviewResult> {
    const evidenceBlock = evidence
      .map((e) =>
        e.topArtifact
          ? // topArtifact is already a relevance-oriented, bounded extract.
            `- ${e.ref}: closest artifact →\n${e.topArtifact}`
          : `- ${e.ref}: MISSING (no artifact found)`,
      )
      .join('\n');
    const res = await this.client.send([
      { role: 'system', content: appendHint(REVIEWER_SYSTEM, opts.hint) },
      {
        role: 'user',
        content:
          `Step: ${step.name}\nIntent: ${step.instructions}\n` +
          `Evidence:\n${evidenceBlock || '(none)'}\n` +
          `Executor result:\n${executorResult}`,
      },
    ]);
    opts.logUsage?.('reviewer', res.usage);
    if (res.kind !== 'content') {
      // Provider/transport error → JUDGE failure (the verdict is unknown), NOT a
      // step failure.
      return {
        kind: 'judge-failure',
        reason: `reviewer error: ${res.kind === 'error' ? res.error : res.kind}`,
      };
    }
    return parseReview(res.content);
  }
}

/** Parse a reviewer reply into a ReviewResult. A well-formed verdict (any of
 *  ok/exists/partial/failed) is an `outcome`. Unparsable, missing/invalid status,
 *  or ok/exists/partial with EMPTY approved (contradictory) is a `judge-failure`
 *  (re-ask, then abort) — never coerced to a step `failed`. */
export function parseReview(content: string): ReviewResult {
  const json = extractJsonObject(content);
  if (json === null)
    return { kind: 'judge-failure', reason: 'unparsable reviewer reply' };
  try {
    const o = JSON.parse(json) as Partial<Outcome>;
    const status = o.status;
    const approved = typeof o.approved === 'string' ? o.approved : '';
    const remainder = typeof o.remainder === 'string' ? o.remainder : '';
    const note = typeof o.note === 'string' ? o.note : '';
    if (
      status !== 'ok' &&
      status !== 'exists' &&
      status !== 'failed' &&
      status !== 'partial'
    ) {
      return { kind: 'judge-failure', reason: 'missing/invalid status' };
    }
    if (
      (status === 'ok' || status === 'exists' || status === 'partial') &&
      approved.length === 0
    ) {
      return {
        kind: 'judge-failure',
        reason: `${status} with empty approved (contradictory)`,
      };
    }
    return { kind: 'outcome', outcome: { status, approved, remainder, note } };
  } catch {
    return { kind: 'judge-failure', reason: 'unparsable reviewer reply' };
  }
}
