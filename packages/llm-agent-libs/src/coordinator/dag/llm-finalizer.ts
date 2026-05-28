import type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
  ILlm,
  Message,
} from '@mcp-abap-adt/llm-agent';

export const FINALIZER_SYSTEM =
  'You synthesize the final user-facing answer for a DAG-coordinated task. ' +
  'You will receive: (1) the user prompt, (2) the plan objective, (3) an ' +
  'ordered execution trace of completed DAG nodes (each with its goal and ' +
  'output). Produce the answer using ONLY the trace outputs. Do NOT propose ' +
  'new data collection. Do NOT include the trace structure in your reply ' +
  "unless the user asked for it. Address every part of the user's prompt.";

export interface LlmFinalizerOptions {
  systemPrompt?: string;
  name?: string;
  model?: string;
}

function renderUserMessage(input: FinalizerInput): string {
  const lines: string[] = [];
  lines.push('# User prompt', input.prompt, '');
  lines.push('# Plan objective', input.objective, '');
  if (input.ancestorContext) {
    const ac = input.ancestorContext;
    if (ac.clarifications.length > 0) {
      lines.push('# Clarifications');
      for (const c of ac.clarifications) {
        lines.push(`- Q: ${c.question}`);
        lines.push(`  A: ${c.answer}`);
      }
      lines.push('');
    }
    if (ac.oracleObservations.length > 0) {
      lines.push('# Oracle observations');
      for (const o of ac.oracleObservations) {
        lines.push(`- Q: ${o.query}`);
        lines.push(`  A: ${o.answer}`);
      }
      lines.push('');
    }
  }
  lines.push('# Execution trace');
  for (const t of input.executionTrace) {
    lines.push(`## Node ${t.nodeId} — ${t.goal}`);
    lines.push(t.output);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Synthesizes the final answer via a single LLM call. NO tools are wired:
 * the LLM cannot escape into another tool-loop. The user message is a
 * deterministic rendering of prompt + objective + ancestorContext + trace.
 */
export class LlmFinalizer implements IFinalizer {
  readonly name: string;
  readonly model?: string;
  private readonly systemPrompt: string;

  constructor(
    private readonly llm: ILlm,
    opts: LlmFinalizerOptions = {},
  ) {
    this.name = opts.name ?? 'llm-finalizer';
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt ?? FINALIZER_SYSTEM;
  }

  async finalize(input: FinalizerInput): Promise<FinalizerResult> {
    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: renderUserMessage(input) },
    ];
    const res = await this.llm.chat(messages, [], {
      signal: input.signal,
      sessionId: input.sessionId,
    });
    if (!res.ok) throw res.error;
    return { output: res.value.content, usage: res.value.usage };
  }
}
