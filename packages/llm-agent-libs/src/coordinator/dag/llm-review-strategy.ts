import type {
  ILlm,
  IReviewStrategy,
  ReviewInput,
  ReviewVerdict,
} from '@mcp-abap-adt/llm-agent';
import { DirectLlmSubAgent } from '../../subagent/direct-llm-subagent.js';

// Static critic instructions. The user prompt, plan and catalog are dynamic and
// go into the per-call `task` (see review()).
const REVIEWER_SYSTEM = `You are a plan reviewer. Given the user request, the available workers, and a proposed DAG plan, decide whether the plan can fulfil the request with those workers.
Respond with ONLY a JSON object:
{"pass": true}  — the plan is adequate
{"pass": false, "feedback": "<what is wrong or what must be clarified>"}  — otherwise`;

/**
 * Role adapter: owns a constrained `DirectLlmSubAgent` critic and turns its
 * string output into a typed `ReviewVerdict`.
 */
export class LlmReviewStrategy implements IReviewStrategy {
  readonly name = 'llm-review';
  private readonly agent: DirectLlmSubAgent;

  constructor(llm: ILlm) {
    this.agent = new DirectLlmSubAgent('reviewer', llm, {
      systemPrompt: REVIEWER_SYSTEM,
      contextPolicy: 'optional',
    });
  }

  async review(input: ReviewInput): Promise<ReviewVerdict> {
    const catalog = input.agents
      .map((a) => `- ${a.name}: ${a.description ?? '(no description)'}`)
      .join('\n');
    const task = `User request:\n${input.prompt}\n\nAvailable workers:\n${
      catalog || '(none)'
    }\n\nProposed plan (JSON):\n${JSON.stringify(input.plan)}`;

    const res = await this.agent.run({
      task,
      sessionId: input.sessionId,
      signal: input.signal,
      layer: 0,
    });

    const match = res.output.match(/\{[\s\S]*\}/);
    if (!match)
      throw new Error(
        `Reviewer output did not contain a JSON object: ${res.output.slice(0, 200)}`,
      );
    let parsed: { pass?: unknown; feedback?: unknown };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error(
        `Reviewer output contained malformed JSON: ${match[0].slice(0, 200)}`,
      );
    }
    if (typeof parsed.pass !== 'boolean') {
      throw new Error(
        `Reviewer verdict must have a boolean 'pass': ${match[0].slice(0, 200)}`,
      );
    }
    if (parsed.pass === false) {
      if (
        typeof parsed.feedback !== 'string' ||
        parsed.feedback.trim() === ''
      ) {
        throw new Error(
          `Reviewer rejection must include a non-empty 'feedback' string: ${match[0].slice(0, 200)}`,
        );
      }
      return { pass: false, feedback: parsed.feedback };
    }
    return { pass: true };
  }
}
