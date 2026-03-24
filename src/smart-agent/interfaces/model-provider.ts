/**
 * Model provider interface for dynamic model discovery and selection.
 */

import type { CallOptions, LlmError, Result } from './types.js';

export interface IModelInfo {
  id: string;
  owned_by?: string;
}

export interface IModelProvider {
  /** Currently configured (default) model name. */
  getModel(): string;

  /** Fetch available models from the provider. Called on demand. */
  getModels(options?: CallOptions): Promise<Result<IModelInfo[], LlmError>>;
}
