import type { ISessionManager } from './types.js';
export declare class NoopSessionManager implements ISessionManager {
    get totalTokens(): number;
    addTokens(): void;
    isOverBudget(): boolean;
    reset(): void;
}
//# sourceMappingURL=noop-session-manager.d.ts.map