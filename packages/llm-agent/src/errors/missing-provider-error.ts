export class MissingProviderError extends Error {
  readonly code = 'MISSING_PROVIDER';
  readonly packageName: string;
  readonly factoryName: string;
  constructor(packageName: string, factoryName: string) {
    super(
      `Provider '${factoryName}' is declared in config but package '${packageName}' is not installed. Run: npm install ${packageName}`,
    );
    this.name = 'MissingProviderError';
    this.packageName = packageName;
    this.factoryName = factoryName;
  }
}
