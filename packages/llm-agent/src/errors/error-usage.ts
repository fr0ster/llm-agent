import type { LlmUsageAttribution } from '../interfaces/types.js';

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

const usageErrorSources = new WeakMap<object, object>();

export function originalUsageError(error: object): object {
  return usageErrorSources.get(error) ?? error;
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
  Object.defineProperties(
    Object.setPrototypeOf(copy, Object.getPrototypeOf(error)),
    {
      ...Object.getOwnPropertyDescriptors(error),
      ...Object.getOwnPropertyDescriptors(attribution),
    },
  );
  usageErrorSources.set(copy, originalUsageError(error));
  return copy as T;
}
