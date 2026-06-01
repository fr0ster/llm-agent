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
import { composeTask } from './compose-task.js';

/** Bound on the self-dispatch tool-loop — enough for a read→observe→answer
 *  cycle without runaway. */
const MAX_TOOL_ITERATIONS = 6;

export class SelfDispatch implements IDispatchStrategy {
  readonly name = 'self';

  constructor(
    private readonly llm: ILlm,
    private readonly systemPrompt?: string,
  ) {}

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
        .map((r) => `- ${r.stepId}: ${r.output.slice(0, 300)}`)
        .join('\n') || '(none)';
    const userMsg = `${composeTask(step, ctx)}\n\nResults so far:\n${priorBlock}`;

    const started = Date.now();
    try {
      // #157: when the coordinator threaded the per-request RAG-selected tools
      // and a tool executor, run a bounded tool-loop so a self-dispatched step
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
          durationMs: Date.now() - started,
          ok: true,
        };
      }

      const res = await this.llm.chat(
        [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg },
        ],
        [],
        { signal: ctx.signal, sessionId: ctx.sessionId },
      );
      if (!res.ok) throw res.error;
      return {
        stepId: step.id,
        output: res.value.content,
        usage: res.value.usage,
        durationMs: Date.now() - started,
        ok: true,
      };
    } catch (err) {
      return {
        stepId: step.id,
        output: '',
        durationMs: Date.now() - started,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Bounded ReAct loop: chat with tools → execute any tool calls via
   *  `ctx.callTool` → feed results back → repeat until the model answers with no
   *  tool call (or the cap is hit). Mirrors the wire shape providers expect
   *  (assistant `tool_calls` followed by matching `tool` messages). */
  private async runToolLoop(
    sys: string,
    userMsg: string,
    tools: LlmTool[],
    ctx: ICoordinatorContext,
  ): Promise<{ content: string; usage?: LlmUsage }> {
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
            promptTokens: usage.promptTokens + u.promptTokens,
            completionTokens: usage.completionTokens + u.completionTokens,
            totalTokens: usage.totalTokens + u.totalTokens,
          }
        : { ...u };
    };

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const res = await this.llm.chat(messages, tools, {
        signal: ctx.signal,
        sessionId: ctx.sessionId,
      });
      if (!res.ok) throw res.error;
      add(res.value.usage);
      const toolCalls = res.value.toolCalls ?? [];
      if (toolCalls.length === 0) return { content: res.value.content, usage };

      messages.push({
        role: 'assistant',
        content: res.value.content || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        })),
      });
      for (const tc of toolCalls) {
        const out = await callTool(tc.name, tc.arguments ?? {}, ctx.signal);
        messages.push({ role: 'tool', content: out, tool_call_id: tc.id });
      }
    }

    // Iteration cap hit: one final tool-free turn so we answer from what was
    // gathered instead of returning empty.
    const final = await this.llm.chat(messages, [], {
      signal: ctx.signal,
      sessionId: ctx.sessionId,
    });
    if (!final.ok) throw final.error;
    add(final.value.usage);
    return { content: final.value.content, usage };
  }
}
