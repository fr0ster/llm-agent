import type {
  LlmComponent,
  LlmUsageAttribution,
} from '@mcp-abap-adt/llm-agent';
import type { PipelineContext } from '../context.js';

export function logRoleUsage(
  ctx: PipelineContext,
  component: LlmComponent,
  attribution?: LlmUsageAttribution | null,
  fallbackModel?: string,
  durationMs = 0,
): void {
  const requestId = ctx.options?.trace?.traceId;
  if (attribution?.usageByModel) {
    for (const [model, usage] of Object.entries(attribution.usageByModel)) {
      ctx.requestLogger.logLlmCall({
        ...usage,
        component,
        model,
        durationMs: 0,
        requestId,
      });
    }
  } else if (attribution?.usage) {
    ctx.requestLogger.logLlmCall({
      ...attribution.usage,
      component,
      model: attribution.model ?? fallbackModel ?? 'unknown',
      durationMs,
      requestId,
    });
  }
}
