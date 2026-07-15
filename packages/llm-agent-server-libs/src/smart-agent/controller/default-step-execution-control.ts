import type {
  IStepBudget,
  IStepExecutionControl,
  StepControlContext,
  StepControlDecision,
  StepRoundState,
} from '@mcp-abap-adt/llm-agent';

/** OUR example step control: wall-clock time budget + prospective maxToolCalls.
 *  Consumer-swappable. */
export class DefaultStepExecutionControl implements IStepExecutionControl {
  beginStep(ctx: StepControlContext): IStepBudget {
    const { maxToolCalls, perStepTimeoutMs } = ctx.budgets;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (perStepTimeoutMs != null && perStepTimeoutMs > 0) {
      timer = setTimeout(
        () =>
          controller.abort(new DOMException('step-timeout', 'TimeoutError')),
        perStepTimeoutMs,
      );
    }
    const timedOut = (s: StepRoundState): boolean =>
      perStepTimeoutMs != null &&
      perStepTimeoutMs > 0 &&
      s.elapsedMs >= perStepTimeoutMs;
    return {
      signal: controller.signal,
      shouldContinueRound(s: StepRoundState): StepControlDecision {
        return timedOut(s)
          ? { continue: false, reason: 'step-timeout' }
          : { continue: true };
      },
      canExecuteTool(s: StepRoundState): StepControlDecision {
        if (maxToolCalls != null && s.toolCallCount + 1 > maxToolCalls) {
          return { continue: false, reason: 'maxToolCalls' };
        }
        return timedOut(s)
          ? { continue: false, reason: 'step-timeout' }
          : { continue: true };
      },
      dispose(): void {
        if (timer !== undefined) clearTimeout(timer);
      },
    };
  }
}
