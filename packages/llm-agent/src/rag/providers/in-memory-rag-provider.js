import { InMemoryRag } from '../in-memory-rag.js';
import { AbstractRagProvider } from './base-provider.js';
export class InMemoryRagProvider extends AbstractRagProvider {
  name;
  kind = 'vector';
  editable;
  supportedScopes = ['session'];
  inMemoryCfg;
  constructor(cfg) {
    super();
    this.name = cfg.name;
    this.editable = cfg.editable ?? true;
    this.inMemoryCfg = cfg.inMemoryRagConfig;
    if (cfg.idStrategyFactory) this.idStrategyFactory = cfg.idStrategyFactory;
  }
  async createCollection(_name, opts) {
    const scopeCheck = this.checkScope(opts.scope);
    if (!scopeCheck.ok) return scopeCheck;
    const rag = new InMemoryRag(this.inMemoryCfg);
    const editor = this.buildEditor(rag, this.pickIdStrategy(opts));
    return { ok: true, value: { rag, editor } };
  }
}
//# sourceMappingURL=in-memory-rag-provider.js.map
