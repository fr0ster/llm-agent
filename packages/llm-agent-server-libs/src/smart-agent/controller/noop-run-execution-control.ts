import type {
  IRunBudget,
  IRunExecutionControl,
  RunControlContext,
  StepControlDecision,
} from '@mcp-abap-adt/llm-agent';

/** Default run control: no-op (never fires, always continue). Full run-budget impl is a follow-up. */
export class NoopRunExecutionControl implements IRunExecutionControl {
  beginRun(_ctx: RunControlContext): IRunBudget {
    const controller = new AbortController(); // never aborted
    return {
      signal: controller.signal,
      shouldContinue(): StepControlDecision {
        return { continue: true };
      },
      dispose(): void {},
    };
  }
}
