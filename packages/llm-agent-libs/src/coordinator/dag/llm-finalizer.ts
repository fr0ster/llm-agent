import type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
  ILlm,
  LlmCallRecord,
  LlmUsageAttribution,
  Message,
  ModelUsageEntry,
} from '@mcp-abap-adt/llm-agent';
import { addTokenUsage, OrchestratorError } from '@mcp-abap-adt/llm-agent';
import {
  errorUsage,
  mergeUsageCalls,
  withUsageAttribution,
} from '../../logger/llm-call-usage.js';
import { StreamAttemptUsage } from '../../logger/stream-attempt-usage.js';

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
    const attemptUsage = new StreamAttemptUsage();
    const retryCalls: LlmCallRecord[] = [];
    const model = () => this.llm.model ?? this.model;
    const finishUsage = (
      failure?: LlmUsageAttribution,
    ): LlmUsageAttribution => {
      const calls = attemptUsage.records(
        'finalizer',
        model(),
        failure,
        signal,
        retryCalls.length > 0,
      );
      if (retryCalls.length === 0) {
        return { ...attemptUsage.resolve(model(), failure), usageCalls: calls };
      }
      const usageCalls = mergeUsageCalls(retryCalls, calls);
      const byModel = new Map<string, ModelUsageEntry>();
      for (const { model, requests = 1, ...usage } of usageCalls) {
        const previous = byModel.get(model);
        const totals = addTokenUsage(previous, usage);
        if (totals)
          byModel.set(model, {
            ...totals,
            requests: (previous?.requests ?? 0) + requests,
          });
      }
      return { usageCalls, usageByModel: Object.fromEntries(byModel) };
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
          for (const call of attemptUsage.records(
            'finalizer',
            model(),
            retryUsage,
          )) {
            retryCalls.push(call);
          }
          attemptUsage.reset();
          if (buf)
            input.onPartial?.({ kind: 'iteration-end', outcome: 'retry' });
          buf = '';
          continue;
        }
        attemptUsage.add(usage, this.llm.model, chunk.value.usageCalls);
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
      const attribution = finishUsage(errorUsage(error));
      throw attribution.usageCalls?.length
        ? withUsageAttribution(error, attribution)
        : error;
    }
    return { output: buf, ...finishUsage() };
  }
}
