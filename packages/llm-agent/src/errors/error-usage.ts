import type { LlmUsageAttribution } from '../interfaces/types.js';
import { errorCauseChain } from './error-details.js';

/** Read telemetry from external errors without copying their error code or cause. */
export function errorUsage<T>(error: T): LlmUsageAttribution {
  const attribution: LlmUsageAttribution = {};
  for (const current of errorCauseChain(error)) {
    const own = ownErrorUsage(current);
    attribution.usage ??= own.usage;
    attribution.usageByModel ??= own.usageByModel;
    attribution.usageCalls ??= own.usageCalls;
    attribution.model ??= own.model;
  }
  return ownErrorUsage(attribution);
}

function ownErrorUsage<T>(error: T): LlmUsageAttribution {
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

/** Carry telemetry across an error boundary, preferring the first source. */
export function copyErrorUsage<T, S, U = undefined>(
  error: T,
  source: S,
  fallback?: U,
): T {
  const existing = ownErrorUsage(error);
  const attribution: LlmUsageAttribution = {};
  for (const input of [source, fallback, error]) {
    const usage = errorUsage(input);
    attribution.usage ??= usage.usage;
    attribution.usageCalls ??= usage.usageCalls;
    attribution.usageByModel ??= usage.usageByModel;
    attribution.model ??= usage.model;
  }
  if (
    attribution.usage === existing.usage &&
    attribution.usageCalls === existing.usageCalls &&
    attribution.usageByModel === existing.usageByModel &&
    attribution.model === existing.model
  )
    return error;
  return withUsageAttribution(error, ownErrorUsage(attribution));
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
