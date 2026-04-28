export class MissingProviderError extends Error {
    code = 'MISSING_PROVIDER';
    packageName;
    factoryName;
    constructor(packageName, factoryName) {
        super(`Provider '${factoryName}' is declared in config but package '${packageName}' is not installed. Run: npm install ${packageName}`);
        this.name = 'MissingProviderError';
        this.packageName = packageName;
        this.factoryName = factoryName;
    }
}
//# sourceMappingURL=missing-provider-error.js.map