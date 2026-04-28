import type { IRagProvider, IRagProviderRegistry } from '../../interfaces/rag.js';
export declare class SimpleRagProviderRegistry implements IRagProviderRegistry {
    private readonly providers;
    registerProvider(provider: IRagProvider): void;
    getProvider(name: string): IRagProvider | undefined;
    listProviders(): readonly string[];
}
//# sourceMappingURL=simple-provider-registry.d.ts.map