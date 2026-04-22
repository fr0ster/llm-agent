import type { IToolCache } from './types.js';

export class NoopToolCache implements IToolCache {
  get(): undefined {
    return undefined;
  }
  set(): void {}
  clear(): void {}
}
