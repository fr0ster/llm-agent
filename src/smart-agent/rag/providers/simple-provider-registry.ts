import type {
  IRagProvider,
  IRagProviderRegistry,
} from '../../interfaces/rag.js';

export class SimpleRagProviderRegistry implements IRagProviderRegistry {
  private readonly providers = new Map<string, IRagProvider>();

  registerProvider(provider: IRagProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`RAG provider '${provider.name}' is already registered`);
    }
    this.providers.set(provider.name, provider);
  }

  getProvider(name: string): IRagProvider | undefined {
    return this.providers.get(name);
  }

  listProviders(): readonly string[] {
    return Array.from(this.providers.keys());
  }
}
