import type { LlmUsage } from '@mcp-abap-adt/llm-agent';
import { appendHint } from './prompts.js';
import type { ISubagentClient } from './subagent-client.js';

export interface ApprovedResult {
  seq: number;
  content: string;
}

export interface FinalizeOpts {
  hint?: string;
  logUsage?: (role: string, u?: LlmUsage) => void;
  /** Narrator for reduction events (spec: "log every reduction"). */
  log?: (msg: string) => void;
  /**
   * Bounded skills recall block; the finalizer honors any output/delivery
   * directives it states. Agnostic — content is consumer-supplied.
   */
  skillsBlock?: string;
}

export interface FinalizerPolicy {
  /** Total budget B (chars proxy here); overflow → reduce. */
  budget: number;
  /** Per-result cap C (chars). */
  perResultCap: number;
}

/** Single finalizer for BOTH planners: compose the answer from the run-scoped
 *  approved results after `done`. */
export interface IFinalizer {
  finalize(
    goal: string,
    request: string,
    approvedResults: readonly ApprovedResult[],
    opts: FinalizeOpts,
  ): Promise<string>;
}

const FINALIZE_SYSTEM =
  'All planned steps are complete. Using the fetched results below, write the ' +
  'final answer to the user request. Plain text, no JSON. Do not invent facts ' +
  "beyond the provided results. Answer in the LANGUAGE of the user's request " +
  '(the internal step instructions may be in English for tool selection; the ' +
  "user-facing answer must match the user's language).";

const FINALIZE_SKILLS_CLAUSE =
  'A skills block is provided below. Honor any output, delivery, or formatting ' +
  'directives it states exactly; the skills govern delivery only — still do not ' +
  'invent facts beyond the provided results.';

const TRUNC_MARKER = '…[truncated]';

/** Minimum finalize budget: a sub-floor budget is a config error, validated in the
 *  LlmFinalizer constructor — so reduceToBudget can assume the count manifest fits
 *  and never clamps up past the configured value. */
export const MIN_BODY_BUDGET = 64;

/** Order results by seq and cap each to `cap` chars with a marker. Pure. */
export function orderAndTruncate(
  results: readonly ApprovedResult[],
  cap: number,
): ApprovedResult[] {
  return results
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((r) =>
      r.content.length > cap
        ? { seq: r.seq, content: r.content.slice(0, cap) + TRUNC_MARKER }
        : r,
    );
}

/** Compose the finalizer body, reducing to fit `budget` as a map-reduce that keeps
 *  a compact representation of EVERY result. PRECONDITION: budget >= MIN_BODY_BUDGET
 *  (validated in the LlmFinalizer constructor), so reduceToBudget never exceeds the
 *  configured budget.
 *  1. Reduce the LARGEST result's cap (halving, logged) until the body fits or
 *     every result is at the per-result floor.
 *  2. If still over budget, HARD-distribute the budget evenly: each result keeps a
 *     compact head extract sized to its fair share (no whole-result drop).
 *  3. If the budget cannot hold N compact extracts, emit a MANIFEST that lists as
 *     many seq ids as fit plus an EXPLICIT "(+M more of N)" count.
 *  Deterministic; an LLM-summarizer map-reduce is a future variant. */
export function reduceToBudget(
  results: readonly ApprovedResult[],
  perResultCap: number,
  budget: number,
  log?: (msg: string) => void,
): string {
  const FLOOR = 80;
  const SEP = '\n\n';
  const ordered = results.slice().sort((a, b) => a.seq - b.seq);
  if (ordered.length === 0) return '';
  const caps = new Map<number, number>(
    ordered.map((r) => [r.seq, perResultCap]),
  );
  const chunk = (r: ApprovedResult) => {
    const cap = caps.get(r.seq) ?? perResultCap;
    const c =
      r.content.length > cap
        ? r.content.slice(0, cap) + TRUNC_MARKER
        : r.content;
    return `[#${r.seq}] ${c}`;
  };
  const render = () => ordered.map(chunk).join(SEP);
  let body = render();
  // Pass 1: halve the largest reducible result until fit or all at floor.
  while (body.length > budget) {
    let target: number | undefined;
    let largest = -1;
    for (const r of ordered) {
      const cap = caps.get(r.seq) ?? perResultCap;
      const len = Math.min(r.content.length, cap);
      if (cap > FLOOR && len > largest) {
        largest = len;
        target = r.seq;
      }
    }
    if (target === undefined) break; // all at floor
    const next = Math.max(
      FLOOR,
      Math.floor((caps.get(target) ?? perResultCap) / 2),
    );
    caps.set(target, next);
    log?.(`finalizer overflow: reduced result #${target} cap → ${next} chars`);
    body = render();
  }
  // Pass 2: even per-result share so EVERY result keeps a compact extract.
  if (body.length > budget) {
    const n = ordered.length;
    const overheadPerResult =
      `[#${ordered[ordered.length - 1].seq}] `.length +
      TRUNC_MARKER.length +
      SEP.length;
    const share = Math.max(0, Math.floor(budget / n) - overheadPerResult);
    for (const r of ordered) caps.set(r.seq, share);
    log?.(
      `finalizer overflow: even per-result share ${share} chars across ${n} results (none dropped)`,
    );
    body = render();
  }
  // Pass 3: budget too small for N compact extracts → a MANIFEST naming as many
  // seq ids as fit + an EXPLICIT count of the rest (omission never silent).
  if (body.length > budget) {
    const n = ordered.length;
    const ids = ordered.map((r) => `#${r.seq}`);
    let shown = ids.length;
    const build = (count: number) => {
      const omitted = n - count;
      const suffix = omitted > 0 ? ` … (+${omitted} more of ${n})` : '';
      return `[results: ${ids.slice(0, count).join(' ')}${suffix}]`;
    };
    while (shown > 0 && build(shown).length > budget) shown--;
    log?.(
      `finalizer overflow: manifest lists ${shown}/${n} ids, ${n - shown} explicitly counted (budget ${budget})`,
    );
    const manifest = build(shown);
    body = manifest.length <= budget ? manifest : manifest.slice(0, budget);
  }
  return body;
}

export class LlmFinalizer implements IFinalizer {
  constructor(
    private readonly client: ISubagentClient,
    private readonly policy: FinalizerPolicy,
  ) {
    // Validate the budget at construction so reduceToBudget can assume
    // budget >= MIN_BODY_BUDGET and NEVER clamp up past the configured value.
    if (policy.budget < MIN_BODY_BUDGET) {
      throw new Error(
        `finalizer budget ${policy.budget} < MIN_BODY_BUDGET ${MIN_BODY_BUDGET}`,
      );
    }
  }

  async finalize(
    goal: string,
    request: string,
    approvedResults: readonly ApprovedResult[],
    opts: FinalizeOpts,
  ): Promise<string> {
    const body = reduceToBudget(
      approvedResults,
      this.policy.perResultCap,
      this.policy.budget,
      opts.log,
    );
    const skills = opts.skillsBlock?.trim();
    const system = skills
      ? `${appendHint(FINALIZE_SYSTEM, opts.hint)} ${FINALIZE_SKILLS_CLAUSE}`
      : appendHint(FINALIZE_SYSTEM, opts.hint);
    const userContent = skills
      ? `Goal: ${goal}\nRequest: ${request}\nResults:\n${body}\n\nSkills (delivery directives):\n${skills}`
      : `Goal: ${goal}\nRequest: ${request}\nResults:\n${body}`;
    const res = await this.client.send([
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ]);
    opts.logUsage?.('finalizer', res.usage);
    if (res.kind !== 'content') {
      throw new Error(
        `finalizer error: ${res.kind === 'error' ? res.error : res.kind}`,
      );
    }
    return res.content;
  }
}
