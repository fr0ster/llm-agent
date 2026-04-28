export declare class MissingProviderError extends Error {
    readonly code = "MISSING_PROVIDER";
    readonly packageName: string;
    readonly factoryName: string;
    constructor(packageName: string, factoryName: string);
}
//# sourceMappingURL=missing-provider-error.d.ts.map