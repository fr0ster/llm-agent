import type { LlmUsage } from './types.js';

export class InsufficientSignal extends Error {
  readonly missing: string[];
  readonly usage?: LlmUsage;
  constructor(missing: string[], usage?: LlmUsage) {
    super('insufficient');
    this.name = 'InsufficientSignal';
    this.missing = missing;
    this.usage = usage;
  }
}
