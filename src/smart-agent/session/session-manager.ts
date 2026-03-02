import type { ISessionManager } from './types.js';

export class SessionManager implements ISessionManager {
  private _totalTokens = 0;
  private readonly tokenBudget: number;

  constructor(opts: { tokenBudget: number }) {
    this.tokenBudget = opts.tokenBudget;
  }

  get totalTokens(): number {
    return this._totalTokens;
  }

  addTokens(count: number): void {
    this._totalTokens += count;
  }

  isOverBudget(): boolean {
    return this._totalTokens >= this.tokenBudget;
  }

  reset(): void {
    this._totalTokens = 0;
  }
}
