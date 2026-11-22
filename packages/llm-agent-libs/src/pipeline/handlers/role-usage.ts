import type {
  LlmCallRecord,
  LlmComponent,
  LlmUsageAttribution,
} from '@mcp-abap-adt/llm-agent';
import { errorUsage, usageCallRecords } from '../../logger/llm-call-usage.js';
import type { PipelineContext } from '../context.js';

export function logRoleUsage(
  ctx: PipelineContext,
  component: LlmComponent,
  attribution?: LlmUsageAttribution | null,
  fallbackModel?: string,
  durationMs = 0,
): readonly LlmCallRecord[] {
  if (!attribution) return [];
  const calls = usageCallRecords(
    { ...errorUsage(attribution), model: attribution.model ?? fallbackModel },
    component,
    durationMs,
  );
  for (const call of calls) {
    ctx.requestLogger.logLlmCall({
      ...call,
      requestId: ctx.options?.trace?.traceId,
    });
  }
  return calls;
}
