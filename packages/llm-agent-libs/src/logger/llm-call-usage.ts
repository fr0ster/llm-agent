import { randomUUID } from 'node:crypto';
import type {
  CallOptions,
  ILlm,
  LlmCallRecord,
  LlmComponent,
  LlmTool,
  LlmUsageAttribution,
  Message,
} from '@mcp-abap-adt/llm-agent';

export function usageCallRecords(
  attribution: LlmUsageAttribution,
  component: LlmComponent,
  durationMs: number,
  callId?: string,
  countEmpty = false,
): readonly LlmCallRecord[] {
  if (attribution.usageCalls) return attribution.usageCalls;
  if (attribution.usageByModel) {
    return Object.entries(attribution.usageByModel).map(([model, usage]) => ({
      ...usage,
      callId: randomUUID(),
      component,
      model,
      durationMs: 0,
    }));
  }
  if (!attribution.usage && !countEmpty) return [];
  return [
    {
      ...(attribution.usage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      }),
      callId: callId ?? randomUUID(),
      component,
      model: attribution.model ?? 'unknown',
      durationMs,
    },
  ];
}

export function mergeUsageCalls(
  calls: readonly LlmCallRecord[],
  other: readonly LlmCallRecord[],
): readonly LlmCallRecord[] {
  const merged = new Map<string, LlmCallRecord>();
  for (const call of [...calls, ...other]) {
    if (!merged.has(call.callId)) merged.set(call.callId, call);
  }
  return [...merged.values()];
}

/** Read telemetry from external errors without copying their error code or cause. */
export function errorUsage<T>(error: T): LlmUsageAttribution {
  if (typeof error !== 'object' || error === null) return {};
  const { usage, usageByModel, usageCalls, model } =
    error as LlmUsageAttribution;
  return {
    ...(usage && { usage }),
    ...(usageByModel && { usageByModel }),
    ...(usageCalls && { usageCalls }),
    ...(model !== undefined && { model }),
  };
}

/** Keep the error type and telemetry without changing a provider-owned error. */
export function withUsageAttribution<T>(
  error: T,
  attribution: LlmUsageAttribution,
): T {
  if (
    typeof error !== 'object' ||
    error === null ||
    Object.keys(attribution).length === 0
  )
    return error;
  const copy =
    error instanceof DOMException
      ? new DOMException(error.message, error.name)
      : error instanceof Error
        ? new Error()
        : {};
  return Object.defineProperties(
    Object.setPrototypeOf(copy, Object.getPrototypeOf(error)),
    {
      ...Object.getOwnPropertyDescriptors(error),
      ...Object.getOwnPropertyDescriptors(attribution),
    },
  ) as T;
}

export function withUsageCalls<T>(
  error: T,
  calls: readonly LlmCallRecord[],
): T {
  const { usageCalls } = errorUsage(error);
  if (calls.length === 0 || calls === usageCalls) return error;
  return withUsageAttribution(error, {
    usageCalls: usageCalls ? mergeUsageCalls(calls, usageCalls) : calls,
  });
}

/** Capture usage at a non-streaming role or worker call boundary. */
export async function chatWithUsage(
  llm: ILlm,
  component: LlmComponent,
  messages: Message[],
  tools?: LlmTool[],
  options?: CallOptions,
) {
  const callId = randomUUID();
  const start = Date.now();
  try {
    const result = await llm.chat(messages, tools, options);
    if (!result.ok) throw result.error;
    const attribution = { usage: result.value.usage, model: llm.model };
    return {
      ...result.value,
      ...attribution,
      usageCalls: usageCallRecords(
        attribution,
        component,
        Date.now() - start,
        callId,
        true,
      ),
    };
  } catch (error) {
    const failure = errorUsage(error);
    throw withUsageCalls(
      error,
      usageCallRecords(
        { ...failure, model: failure.model ?? llm.model },
        component,
        Date.now() - start,
        callId,
      ),
    );
  }
}
