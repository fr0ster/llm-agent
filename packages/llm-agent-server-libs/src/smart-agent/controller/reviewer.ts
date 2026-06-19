import type { LlmUsage } from '@mcp-abap-adt/llm-agent';
import { extractJsonObject } from './controller-coordinator-handler.js';
import type { ReviewOutcome } from './outcome.js';
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
  /** Defensive cap on the returned `digest` (§B). Defaults to 500 when omitted. */
  maxDigestChars?: number;
}

/** The reviewer's return: EITHER an authoritative step Outcome (incl. a genuine
 *  `failed` verdict → step replan), OR a judge-failure — the reviewer could not
 *  produce ANY usable verdict (provider/transport error, unparsable JSON, or a
 *  missing/invalid status). The controller re-asks a judge-failure within
 *  `maxReviewRetries` and, on exhaustion, DEGRADES it to a failed step (→ replan),
 *  bounded by `maxStepAttempts`/`maxSteps` — it does NOT abort the run. (A
 *  well-formed but contradictory verdict — ok/exists/partial with empty `approved` —
 *  is coerced to a `failed` Outcome in `parseReview`, NOT a judge-failure.) */
export type ReviewResult =
  | { kind: 'outcome'; outcome: ReviewOutcome }
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
  '"remainder":<what is still missing>,"note":<short reason>,' +
  '"digest":<a SHORT plain-text extract of what this step established that the ' +
  'PLANNER needs to decide the next step — e.g. the key names/ids/outcome, NOT ' +
  'the full content>}. ' +
  'Use "ok" when the step is fully satisfied, "exists" when the target already ' +
  'existed (idempotent no-op success), "partial" when only part is done (put the ' +
  'accepted content in "approved" and what remains in "remainder"), "failed" when ' +
  'the result does not satisfy the step. "approved" MUST be non-empty for ok/' +
  'exists/partial. Judge ONLY from the evidence + result; do NOT invent facts. ' +
  'The evidence lists, per required reference, the CLOSEST stored artifact (or ' +
  'MISSING). Decide for YOURSELF whether that artifact actually satisfies the ' +
  'reference — a closest-match artifact may be irrelevant; treat an unsatisfied or ' +
  'missing required reference as "failed" (note: "missing input: <ref>"). ' +
  'The "digest" is REQUIRED and MUST be a non-empty plain-text string (keep it ' +
  'brief — the full result is stored separately). ' +
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
    return parseReview(res.content, opts.maxDigestChars ?? 500);
  }
}

/** Parse a reviewer reply into a ReviewResult. A well-formed verdict (any of
 *  ok/exists/partial/failed) is an `outcome`; ok/exists/partial with EMPTY approved
 *  is coerced to a `failed` outcome (contradictory → replan, not abort). Only a
 *  truly unusable reply — unparsable JSON or missing/invalid status — is a
 *  `judge-failure` (re-ask within budget, then degrade to a failed step). */
export function parseReview(
  content: string,
  maxDigestChars = 500,
): ReviewResult {
  const json = extractJsonObject(content);
  if (json === null)
    return { kind: 'judge-failure', reason: 'unparsable reviewer reply' };
  try {
    const o = JSON.parse(json) as Partial<ReviewOutcome>;
    const status = o.status;
    const approved = typeof o.approved === 'string' ? o.approved : '';
    const remainder = typeof o.remainder === 'string' ? o.remainder : '';
    const note = typeof o.note === 'string' ? o.note : '';
    const rawDigest = typeof o.digest === 'string' ? o.digest : '';
    if (
      status !== 'ok' &&
      status !== 'exists' &&
      status !== 'failed' &&
      status !== 'partial'
    ) {
      return { kind: 'judge-failure', reason: 'missing/invalid status' };
    }
    // Digest is REQUIRED on every settle (it is the planner's board content). A
    // missing/empty digest is a judge-failure (re-ask), distinct from a real
    // verdict. Bound it defensively (the full result is in RAG regardless).
    if (rawDigest.trim().length === 0) {
      return { kind: 'judge-failure', reason: 'missing digest' };
    }
    const digest = rawDigest.slice(0, maxDigestChars);
    if (
      (status === 'ok' || status === 'exists' || status === 'partial') &&
      approved.length === 0
    ) {
      const coercedNote = note
        ? `${note} [coerced: reviewer returned ${status} with empty approved]`
        : `reviewer returned ${status} with empty approved`;
      return {
        kind: 'outcome',
        outcome: {
          status: 'failed',
          approved: '',
          remainder: remainder || approved,
          note: coercedNote,
          digest: (note || coercedNote).slice(0, maxDigestChars),
        },
      };
    }
    if (status === 'partial' && remainder.trim().length === 0) {
      return {
        kind: 'outcome',
        outcome: { status: 'ok', approved, remainder: '', note, digest },
      };
    }
    return {
      kind: 'outcome',
      outcome: { status, approved, remainder, note, digest },
    };
  } catch {
    return { kind: 'judge-failure', reason: 'unparsable reviewer reply' };
  }
}
