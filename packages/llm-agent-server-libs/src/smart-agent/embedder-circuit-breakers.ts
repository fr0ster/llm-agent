import {
  CircuitBreaker,
  type CircuitBreakerConfig,
  type IEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { normalizeEmbedderProvider } from '@mcp-abap-adt/llm-agent-rag';
import type { SmartServerRagConfig } from './rag-config.js';

/** Server-wide identities; stores and sessions share breakers, never RAG state. */
export class EmbedderCircuitBreakers {
  private readonly configured = new Map<string, CircuitBreaker>();
  private readonly injected = new Map<IEmbedder, CircuitBreaker>();
  private readonly labels = new Map<CircuitBreaker, string>();

  constructor(private readonly config: CircuitBreakerConfig) {}

  resolve(
    rag: SmartServerRagConfig | undefined,
    embedder: IEmbedder | undefined,
    main?: CircuitBreaker,
  ): CircuitBreaker | undefined {
    if (
      !embedder &&
      (!rag || (rag.store.type === 'in-memory' && !rag.embedder))
    ) {
      return undefined;
    }
    const section = rag?.embedder ?? { provider: 'ollama' };
    const provider = normalizeEmbedderProvider(section.provider);
    const key = JSON.stringify(
      section.factory !== undefined
        ? { factory: section.factory, model: section.model, url: section.url }
        : {
            provider,
            model: section.model,
            url: provider === 'sap-ai-core' ? undefined : section.url,
            credentialRef: section.credentialRef,
            resourceGroup:
              provider === 'sap-ai-core' ? section.resourceGroup : undefined,
            scenario:
              provider === 'sap-ai-core'
                ? (section.scenario ?? 'orchestration')
                : undefined,
          },
    );
    const current = embedder
      ? this.injected.get(embedder)
      : this.configured.get(key);
    if (current) return current;
    const breaker = main ?? new CircuitBreaker(this.config);
    if (embedder) this.injected.set(embedder, breaker);
    else this.configured.set(key, breaker);
    this.labels.set(
      breaker,
      `embedder:${this.labels.size + 1}:${embedder ? 'injected' : (section.factory ?? section.provider)}${!embedder && section.model ? `:${section.model}` : ''}`,
    );
    return breaker;
  }

  label(breaker: CircuitBreaker): string | undefined {
    return this.labels.get(breaker);
  }

  list(): readonly CircuitBreaker[] {
    return [...this.labels.keys()];
  }
}
