import type {
  IEmbedder,
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
  RagProviderCreateCollectionOptions,
} from '../../interfaces/rag.js';
import type { Result } from '../../interfaces/types.js';
import { RagError } from '../../interfaces/types.js';
import { VectorRag, type VectorRagConfig } from '../vector-rag.js';
import { AbstractRagProvider } from './base-provider.js';

export interface VectorRagProviderConfig {
  name: string;
  embedder: IEmbedder;
  editable?: boolean;
  /**
   * Scopes this provider accepts. Default `['session']`: its stores live in
   * this process and are gone after a restart, so whether a longer-lived scope
   * fits is the host's call.
   */
  supportedScopes?: readonly RagCollectionScope[];
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
  readonly supportedScopes: readonly RagCollectionScope[];

  private readonly embedder: IEmbedder;
  private readonly vectorRagConfig?: VectorRagConfig;

  constructor(cfg: VectorRagProviderConfig) {
    super();
    this.name = cfg.name;
    this.embedder = cfg.embedder;
    this.editable = cfg.editable ?? true;
    this.supportedScopes = cfg.supportedScopes ?? ['session'];
    this.vectorRagConfig = cfg.vectorRagConfig;
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
    const rag = new VectorRag(this.embedder, this.vectorRagConfig ?? {});
    const editor = this.buildEditor(rag, this.pickIdStrategy(checked.value));
    return { ok: true, value: { rag, editor } };
  }
}
