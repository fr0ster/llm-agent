import type { ISessionManager } from './types.js';

export class NoopSessionManager implements ISessionManager {
  get totalTokens(): number {
    return 0;
  }
  addTokens(): void {}
  isOverBudget(): boolean {
    return false;
  }
  reset(): void {}
}
