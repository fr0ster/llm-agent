import type { CallOptions, LlmUsage } from '@mcp-abap-adt/llm-agent';
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
  /** Request-scoped call options (sessionLogger / trace / signal) threaded to
   *  the underlying `send`, so the finalize LLM I/O is captured under the
   *  same session/trace as the rest of the run. */
  callOptions?: CallOptions;
}

export interface FinalizerPolicy {
  /** @deprecated Retained for compatibility; results are never truncated. */
  budget: number;
  /** @deprecated Retained for compatibility; results are never truncated. */
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

/** Legacy budget constant retained for source compatibility; no cap is applied. */
export const MIN_BODY_BUDGET = 64;

/** Order complete results by seq. The legacy cap argument is ignored. */
export function orderAndTruncate(
  results: readonly ApprovedResult[],
  _cap: number,
): ApprovedResult[] {
  return results.slice().sort((a, b) => a.seq - b.seq);
}

/** Render every complete result. Legacy budget arguments are ignored. */
export function reduceToBudget(
  results: readonly ApprovedResult[],
  _perResultCap: number,
  _budget: number,
  _log?: (msg: string) => void,
): string {
  return orderAndTruncate(results, _perResultCap)
    .map((result) => `[#${result.seq}] ${result.content}`)
    .join('\n\n');
}

export class LlmFinalizer implements IFinalizer {
  constructor(
    private readonly client: ISubagentClient,
    private readonly policy: FinalizerPolicy,
  ) {}

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
    const res = await this.client.send(
      [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      undefined,
      opts.callOptions,
    );
    opts.logUsage?.('finalizer', res.usage);
    if (res.kind !== 'content') {
      throw new Error(
        `finalizer error: ${res.kind === 'error' ? res.error : res.kind}`,
      );
    }
    return res.content;
  }
}
