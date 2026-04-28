import type { ISessionManager } from './types.js';
export declare class SessionManager implements ISessionManager {
    private _totalTokens;
    private readonly tokenBudget;
    constructor(opts: {
        tokenBudget: number;
    });
    get totalTokens(): number;
    addTokens(count: number): void;
    isOverBudget(): boolean;
    reset(): void;
}
//# sourceMappingURL=session-manager.d.ts.map