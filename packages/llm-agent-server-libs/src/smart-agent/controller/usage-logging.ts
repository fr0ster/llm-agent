import type {
  IRequestLogger,
  LlmComponent,
  LlmUsage,
} from '@mcp-abap-adt/llm-agent';

// ---------------------------------------------------------------------------
// Debug logging — private copy (mirrors the one in controller-coordinator-handler.ts
// to avoid creating an inverted dependency back to the handler).
// ---------------------------------------------------------------------------

function dlog(msg: string): void {
  if (process.env.DEBUG_CONTROLLER) console.error(`[controller] ${msg}`);
}

/**
 * Build a request-time `logUsage(role, usage)` that writes each subagent call
 * into the per-request `IRequestLogger` (the single aggregator), attributing the
 * role's configured model. The role is explicit at the call site, so the shared
 * planner/finalizer client is attributed correctly. `durationMs: 0` — the seam
 * carries no timing (matches the rag-query precedent).
 */
export function makeLogUsage(
  requestLogger: IRequestLogger,
  requestId: string | undefined,
  models: {
    evaluator: string;
    planner: string;
    executor: string;
    reviewer?: string;
    finalizer?: string;
  },
): (role: string, u?: LlmUsage) => void {
  return (role, u) => {
    if (!u) return;
    const model =
      role === 'finalizer'
        ? (models.finalizer ?? models.planner)
        : role === 'reviewer'
          ? (models.reviewer ?? models.planner)
          : role === 'embedding'
            ? 'embedder'
            : ((models as Record<string, string>)[role] ?? 'unknown');
    requestLogger.logLlmCall({
      component: role as LlmComponent,
      model,
      promptTokens: u.promptTokens ?? 0,
      completionTokens: u.completionTokens ?? 0,
      totalTokens: u.totalTokens ?? 0,
      durationMs: 0,
      requestId,
    });
    dlog(
      `tokens ${role}: prompt=${u.promptTokens} completion=${u.completionTokens} total=${u.totalTokens}`,
    );
  };
}
