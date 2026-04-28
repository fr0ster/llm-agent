export interface ParsedServiceKey {
    clientId: string;
    clientSecret: string;
    /** Fully qualified token endpoint incl. `/oauth/token`. */
    tokenUrl: string;
    /** AI Core REST API base URL (no trailing slash). */
    apiBaseUrl: string;
}
export declare function parseServiceKey(raw: string): ParsedServiceKey;
//# sourceMappingURL=service-key.d.ts.map