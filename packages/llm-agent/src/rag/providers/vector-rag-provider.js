import { VectorRag } from '../vector-rag.js';
import { AbstractRagProvider } from './base-provider.js';
export class VectorRagProvider extends AbstractRagProvider {
  name;
  kind = 'vector';
  editable;
  supportedScopes = ['session'];
  embedder;
  vectorRagConfig;
  constructor(cfg) {
    super();
    this.name = cfg.name;
    this.embedder = cfg.embedder;
    this.editable = cfg.editable ?? true;
    this.vectorRagConfig = cfg.vectorRagConfig;
    if (cfg.idStrategyFactory) this.idStrategyFactory = cfg.idStrategyFactory;
  }
  async createCollection(_name, opts) {
    const scopeCheck = this.checkScope(opts.scope);
    if (!scopeCheck.ok) return scopeCheck;
    const rag = new VectorRag(this.embedder, this.vectorRagConfig ?? {});
    const editor = this.buildEditor(rag, this.pickIdStrategy(opts));
    return { ok: true, value: { rag, editor } };
  }
}
//# sourceMappingURL=vector-rag-provider.js.map
