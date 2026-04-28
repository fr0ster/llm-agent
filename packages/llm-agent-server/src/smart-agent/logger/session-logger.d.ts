export declare class SessionLogger {
    private readonly baseLogDir;
    private readonly sessionId;
    private readonly traceId;
    private requestDir;
    private fileIndex;
    constructor(baseLogDir: string | null, sessionId: string, traceId: string);
    logStep(name: string, data: unknown): void;
}
//# sourceMappingURL=session-logger.d.ts.map