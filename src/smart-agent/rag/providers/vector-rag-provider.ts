import type {
  IEmbedder,
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import type { RagError, Result } from '../../interfaces/types.js';
import { VectorRag, type VectorRagConfig } from '../vector-rag.js';
import { AbstractRagProvider } from './base-provider.js';

export interface VectorRagProviderConfig {
  name: string;
  embedder: IEmbedder;
  editable?: boolean;
  vectorRagConfig?: VectorRagConfig;
  idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;
}

export class VectorRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes = ['session'] as const;

  private readonly embedder: IEmbedder;
  private readonly vectorRagConfig?: VectorRagConfig;

  constructor(cfg: VectorRagProviderConfig) {
    super();
    this.name = cfg.name;
    this.embedder = cfg.embedder;
    this.editable = cfg.editable ?? true;
    this.vectorRagConfig = cfg.vectorRagConfig;
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
    const rag = new VectorRag(this.embedder, this.vectorRagConfig ?? {});
    const editor = this.buildEditor(rag, this.pickIdStrategy(opts));
    return { ok: true, value: { rag, editor } };
  }
}
