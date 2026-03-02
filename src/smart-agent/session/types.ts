export interface ISessionManager {
  addTokens(count: number): void;
  isOverBudget(): boolean;
  reset(): void;
  readonly totalTokens: number;
}
