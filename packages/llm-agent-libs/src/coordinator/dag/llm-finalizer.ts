import type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
  ILlm,
  LlmUsage,
  LlmUsageAttribution,
  Message,
  ModelUsageEntry,
} from '@mcp-abap-adt/llm-agent';
import { addTokenUsage, OrchestratorError } from '@mcp-abap-adt/llm-agent';

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
 * Synthesizes the final answer via an LLM stream. NO tools are wired:
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
    const { signal, sessionId, caller } = input;
    let buf = '';
    let attemptUsage: LlmUsage | undefined;
    let attemptModel: string | undefined;
    const usageByModel = new Map<string, ModelUsageEntry>();
    const recordAttempt = (usage?: LlmUsage, model?: string): void => {
      const key = model ?? this.model ?? 'unknown';
      const previous = usageByModel.get(key);
      usageByModel.set(key, {
        ...(addTokenUsage(previous, usage) ?? {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        }),
        requests: (previous?.requests ?? 0) + 1,
      });
    };
    const finishUsage = (
      failure?: LlmUsageAttribution,
    ): LlmUsageAttribution => {
      const usage = failure?.usage ?? attemptUsage;
      const model =
        failure?.model ?? attemptModel ?? this.llm.model ?? this.model;
      if (usageByModel.size === 0) return { usage, model };
      recordAttempt(usage, model);
      return { usageByModel: Object.fromEntries(usageByModel) };
    };
    try {
      const stream = this.llm.streamChat(messages, [], {
        signal,
        sessionId,
        caller,
        usage: input.usage?.with({ role: 'finalizer' }),
        includeStreamRetryUsage: true,
      });
      for await (const chunk of stream) {
        if (!chunk.ok) throw chunk.error;
        const { content, finishReason, reset, retryUsage, usage } = chunk.value;
        if (reset) {
          recordAttempt(
            retryUsage?.usage ?? attemptUsage,
            retryUsage?.model ?? attemptModel ?? this.llm.model,
          );
          attemptUsage = undefined;
          attemptModel = undefined;
          if (buf)
            input.onPartial?.({ kind: 'iteration-end', outcome: 'retry' });
          buf = '';
          continue;
        }
        attemptModel = this.llm.model ?? attemptModel;
        attemptUsage = addTokenUsage(attemptUsage, usage);
        if (finishReason === 'length')
          throw new OrchestratorError(
            'LLM response was truncated at a token limit.',
            'LLM_OUTPUT_TRUNCATED',
          );
        if (content) {
          buf += content;
          input.onPartial?.({ kind: 'content', delta: content });
        }
      }
    } catch (error) {
      if (typeof error !== 'object' || error === null) throw error;
      throw Object.assign(error, finishUsage(error as LlmUsageAttribution));
    }
    return { output: buf, ...finishUsage() };
  }
}
