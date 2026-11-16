import type { LLMCallOptions } from './types.js';

/** Validate the cache switch at YAML and HTTP boundaries; preserve omission. */
export function promptCacheOptions(
  input: object,
): Pick<LLMCallOptions, 'promptCaching'> {
  const result: Pick<LLMCallOptions, 'promptCaching'> = {};
  if ('promptCaching' in input && input.promptCaching !== undefined) {
    if (typeof input.promptCaching !== 'boolean')
      throw new Error('promptCaching must be a boolean');
    result.promptCaching = input.promptCaching;
  }
  return result;
}
