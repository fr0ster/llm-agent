import type {
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
  RagProviderCreateCollectionOptions,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { AbstractRagProvider, RagError } from '@mcp-abap-adt/llm-agent';
import { InMemoryRag, type InMemoryRagConfig } from '../in-memory-rag.js';

export interface InMemoryRagProviderConfig {
  name: string;
  editable?: boolean;
  /**
   * Scopes this provider accepts. Default `['session']`: its stores live in
   * this process and are gone after a restart, so whether a longer-lived scope
   * fits is the host's call.
   */
  supportedScopes?: readonly RagCollectionScope[];
  inMemoryRagConfig?: InMemoryRagConfig;
  idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;
}

export class InMemoryRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  private readonly inMemoryCfg?: InMemoryRagConfig;

  constructor(cfg: InMemoryRagProviderConfig) {
    super();
    this.name = cfg.name;
    this.editable = cfg.editable ?? true;
    this.supportedScopes = cfg.supportedScopes ?? ['session'];
    this.inMemoryCfg = cfg.inMemoryRagConfig;
    if (cfg.idStrategyFactory) this.idStrategyFactory = cfg.idStrategyFactory;
  }

  async createCollection(
    _name: string,
    opts: RagProviderCreateCollectionOptions,
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>> {
    const checked = this.checkCreateOptions(opts);
    if (!checked.ok) return checked;
    if (opts.adoptExisting === true) {
      return {
        ok: false,
        error: new RagError(
          `Provider '${this.name}' keeps no store outside this process, so there is nothing to adopt`,
          'RAG_CREATE_ERROR',
        ),
      };
    }
    const rag = new InMemoryRag(this.inMemoryCfg);
    const editor = this.buildEditor(rag, this.pickIdStrategy(checked.value));
    return { ok: true, value: { rag, editor } };
  }
}
