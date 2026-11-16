import type { LLMCallOptions } from './types.js';

/** Validate cache knobs at YAML and HTTP boundaries; preserve omitted values. */
export function promptCacheOptions(
  input: object,
): Pick<
  LLMCallOptions,
  'promptCaching' | 'promptCacheKey' | 'promptCacheRetention'
> {
  const result: Pick<
    LLMCallOptions,
    'promptCaching' | 'promptCacheKey' | 'promptCacheRetention'
  > = {};
  if ('promptCaching' in input && input.promptCaching !== undefined) {
    const value = input.promptCaching;
    if (value !== 'off' && value !== '5m' && value !== '1h')
      throw new Error('promptCaching must be off, 5m, or 1h');
    result.promptCaching = value;
  }
  if ('promptCacheKey' in input && input.promptCacheKey !== undefined) {
    if (typeof input.promptCacheKey !== 'string')
      throw new Error('promptCacheKey must be a string');
    result.promptCacheKey = input.promptCacheKey;
  }
  if (
    'promptCacheRetention' in input &&
    input.promptCacheRetention !== undefined
  ) {
    const value = input.promptCacheRetention;
    if (value !== 'in_memory' && value !== '24h')
      throw new Error('promptCacheRetention must be in_memory or 24h');
    result.promptCacheRetention = value;
  }
  return result;
}
