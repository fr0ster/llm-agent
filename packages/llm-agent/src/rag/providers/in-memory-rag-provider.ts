import type {
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import type { RagError, Result } from '../../interfaces/types.js';
import { InMemoryRag, type InMemoryRagConfig } from '../in-memory-rag.js';
import { AbstractRagProvider } from './base-provider.js';

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
    opts: {
      scope: RagCollectionScope;
      sessionId?: string;
      userId?: string;
    },
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>> {
    const scopeCheck = this.checkScope(opts.scope);
    if (!scopeCheck.ok) return scopeCheck;
    const rag = new InMemoryRag(this.inMemoryCfg);
    const editor = this.buildEditor(rag, this.pickIdStrategy(opts));
    return { ok: true, value: { rag, editor } };
  }
}
