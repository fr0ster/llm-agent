import type {
  ICoordinatorContext,
  IDispatchStrategy,
  ILlm,
  LlmTool,
  LlmUsage,
  Message,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { addCacheTokenUsage, terminalRunError } from '@mcp-abap-adt/llm-agent';
import { normalizeLoopLimit } from '../../config/normalize-max-iterations.js';
import { ToolResponseRound } from '../../pipeline/handlers/tool-response-round.js';
import { llmOutputTruncation } from '../llm-output-truncation.js';
import { composeTask } from './compose-task.js';

export class SelfDispatch implements IDispatchStrategy {
  readonly name = 'self';
  private readonly maxIterations?: number;
  private readonly maxToolCalls?: number;

  constructor(
    private readonly llm: ILlm,
    private readonly systemPrompt?: string,
    maxIterations?: number | null,
    maxToolCalls?: number | null,
  ) {
    this.maxIterations = normalizeLoopLimit(maxIterations, 'maxIterations');
    this.maxToolCalls = normalizeLoopLimit(maxToolCalls, 'maxToolCalls');
  }

  async dispatch(
    step: PlanStep,
    ctx: ICoordinatorContext,
  ): Promise<StepResult> {
    const sys =
      this.systemPrompt ??
      ctx.systemPrompt ??
      'You are an autonomous agent. Complete the user-assigned step concisely.';
    const priorBlock =
      Object.values(ctx.stepResults)
        .map((r) => `- ${r.stepId}: ${r.output}`)
        .join('\n') || '(none)';
    const userMsg = `${composeTask(step, ctx)}\n\nResults so far:\n${priorBlock}`;

    const started = Date.now();
    try {
      // #157: when the coordinator threaded the per-request RAG-selected tools
      // and a tool executor, run a tool-loop so a self-dispatched step
      // can actually CALL MCP (read a table, list a package, …) instead of a
      // single toolless chat that hallucinates the result. No tools / no
      // executor → the legacy single-chat behaviour (below).
      const tools = (ctx.selectedTools ?? []) as LlmTool[];
      if (tools.length > 0 && typeof ctx.callTool === 'function') {
        const r = await this.runToolLoop(sys, userMsg, tools, ctx);
        return {
          stepId: step.id,
          output: r.content,
          usage: r.usage,
          budgetExhausted: r.budgetExhausted,
          toolCallCount: r.toolCallCount,
          maxToolCalls: r.maxToolCalls,
          durationMs: Date.now() - started,
          ok: r.terminalError === undefined,
          ...(r.terminalError
            ? { error: r.terminalError.message, terminalError: r.terminalError }
            : {}),
        };
      }

      const limits = ctx.loopLimits ?? { maxToolCalls: this.maxToolCalls };
      const maxToolCalls = normalizeLoopLimit(
        limits.maxToolCalls,
        'maxToolCalls',
      );
      const toolCallCount = ctx.toolCallCount ?? 0;
      const res = await this.llm.chat(
        [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg },
        ],
        [],
        {
          usage: ctx.usage?.with({ role: 'executor' }),
          signal: ctx.signal,
          sessionId: ctx.sessionId,
          caller: ctx.caller,
        },
      );
      if (!res.ok) throw res.error;
      const terminalError = llmOutputTruncation(res.value.finishReason);
      return {
        stepId: step.id,
        output: terminalError ? '' : res.value.content,
        usage: res.value.usage,
        budgetExhausted:
          (maxToolCalls !== undefined && toolCallCount >= maxToolCalls) ||
          undefined,
        toolCallCount,
        maxToolCalls,
        durationMs: Date.now() - started,
        ok: terminalError === undefined,
        ...(terminalError
          ? { error: terminalError.message, terminalError }
          : {}),
      };
    } catch (err) {
      const terminalError = terminalRunError(err);
      return {
        stepId: step.id,
        output: '',
        durationMs: Date.now() - started,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(terminalError ? { terminalError } : {}),
      };
    }
  }

  /** ReAct loop: chat with tools → execute any tool calls via
   *  `ctx.callTool` → feed results back → repeat until the model answers with no
   *  tool call (or an explicit cap is hit). Mirrors the wire shape providers expect
   *  (assistant `tool_calls` followed by matching `tool` messages). */
  private async runToolLoop(
    sys: string,
    userMsg: string,
    tools: LlmTool[],
    ctx: ICoordinatorContext,
  ): Promise<
    { content: string; usage?: LlmUsage } & Pick<
      StepResult,
      'budgetExhausted' | 'toolCallCount' | 'maxToolCalls' | 'terminalError'
    >
  > {
    const limits = ctx.loopLimits ?? {
      maxIterations: this.maxIterations,
      maxToolCalls: this.maxToolCalls,
    };
    const maxIterations = normalizeLoopLimit(
      limits.maxIterations,
      'maxIterations',
    );
    const maxToolCalls = normalizeLoopLimit(
      limits.maxToolCalls,
      'maxToolCalls',
    );
    let toolCallCount = ctx.toolCallCount ?? 0;
    const exhausted = () =>
      maxToolCalls !== undefined && toolCallCount >= maxToolCalls;
    const callTool = ctx.callTool as NonNullable<
      ICoordinatorContext['callTool']
    >;
    const messages: Message[] = [
      { role: 'system', content: sys },
      { role: 'user', content: userMsg },
    ];
    let usage: LlmUsage | undefined;
    const add = (u?: LlmUsage) => {
      if (!u) return;
      usage = usage
        ? {
            ...addCacheTokenUsage(usage, u),
            promptTokens: usage.promptTokens + u.promptTokens,
            completionTokens: usage.completionTokens + u.completionTokens,
            totalTokens: usage.totalTokens + u.totalTokens,
          }
        : { ...u };
    };

    for (
      let iter = 0;
      (maxIterations === undefined || iter < maxIterations) && !exhausted();
      iter++
    ) {
      const res = await this.llm.chat(messages, tools, {
        usage: ctx.usage?.with({ role: 'executor' }),
        signal: ctx.signal,
        sessionId: ctx.sessionId,
        caller: ctx.caller,
      });
      if (!res.ok) throw res.error;
      add(res.value.usage);
      const terminalError = llmOutputTruncation(res.value.finishReason);
      if (terminalError)
        return {
          content: '',
          terminalError,
          usage,
          toolCallCount,
          maxToolCalls,
        };
      const modelCalls =
        res.value.finishReason === 'tool_calls'
          ? (res.value.toolCalls ?? [])
          : [];
      if (modelCalls.length === 0) {
        return {
          content: res.value.content,
          usage,
          toolCallCount,
          maxToolCalls,
        };
      }

      const round = new ToolResponseRound(
        res.value.content,
        modelCalls.map((call) => ({
          ...call,
          arguments: call.rawArguments ?? JSON.stringify(call.arguments),
        })),
        undefined,
        undefined,
        res.value.providerOutput,
      );
      const toolCalls = round.executableCalls();
      for (const tc of toolCalls) {
        if (exhausted()) {
          round.resolve(
            tc,
            `Error: not executed: tool-call budget of ${maxToolCalls} for this request is exhausted; return what you have and report what is missing`,
            true,
          );
          continue;
        }
        toolCallCount++;
        ctx.toolCallCount = toolCallCount;
        try {
          ctx.onToolCallCount?.(toolCallCount, maxToolCalls);
        } catch {
          // Observers cannot affect execution.
        }
        const out = await callTool(tc.name, tc.arguments ?? {}, ctx.signal, {
          caller: ctx.caller,
          sessionId: ctx.sessionId,
          usage: ctx.usage?.with({ role: 'executor' }),
        });
        round.resolve(tc, out);
      }
      const complete = round.finish();
      messages.push(complete.assistant, ...complete.results);
    }

    // A limit was hit: one final tool-free turn so we answer from what was
    // gathered instead of returning empty.
    const final = await this.llm.chat(messages, [], {
      usage: ctx.usage?.with({ role: 'executor' }),
      signal: ctx.signal,
      sessionId: ctx.sessionId,
      caller: ctx.caller,
    });
    if (!final.ok) throw final.error;
    add(final.value.usage);
    const terminalError = llmOutputTruncation(final.value.finishReason);
    return {
      content: terminalError ? '' : final.value.content,
      usage,
      budgetExhausted: exhausted() || undefined,
      toolCallCount,
      maxToolCalls,
      ...(terminalError ? { terminalError } : {}),
    };
  }
}
