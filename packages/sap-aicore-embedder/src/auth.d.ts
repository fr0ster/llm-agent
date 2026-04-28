export interface TokenProviderConfig {
    clientId: string;
    clientSecret: string;
    tokenUrl: string;
}
export interface GetTokenOptions {
    /**
     * Skip the local expiry cache. Note: if another `getToken()` call is already
     * fetching a token, this flag coalesces into that in-flight request rather
     * than starting a second one.
     */
    forceRefresh?: boolean;
}
export declare class TokenProvider {
    private readonly cfg;
    private cachedToken;
    private cachedExpiryMs;
    private inFlight;
    constructor(cfg: TokenProviderConfig);
    getToken(options?: GetTokenOptions): Promise<string>;
    private fetchToken;
}
//# sourceMappingURL=auth.d.ts.map