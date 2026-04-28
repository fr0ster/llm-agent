export class SimpleRagProviderRegistry {
    providers = new Map();
    registerProvider(provider) {
        if (this.providers.has(provider.name)) {
            throw new Error(`RAG provider '${provider.name}' is already registered`);
        }
        this.providers.set(provider.name, provider);
    }
    getProvider(name) {
        return this.providers.get(name);
    }
    listProviders() {
        return Array.from(this.providers.keys());
    }
}
//# sourceMappingURL=simple-provider-registry.js.map