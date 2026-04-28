import {
  AbstractRagProvider as BaseRagProvider,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import { QdrantRag } from './qdrant-rag.js';
export class QdrantRagProvider extends BaseRagProvider {
  name;
  kind = 'vector';
  editable;
  supportedScopes;
  url;
  apiKey;
  embedder;
  timeoutMs;
  constructor(cfg) {
    super();
    this.name = cfg.name;
    this.url = cfg.url.replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.embedder = cfg.embedder;
    this.timeoutMs = cfg.timeoutMs;
    this.editable = cfg.editable ?? true;
    this.supportedScopes = cfg.supportedScopes ?? ['session', 'user', 'global'];
    if (cfg.idStrategyFactory) this.idStrategyFactory = cfg.idStrategyFactory;
  }
  async createCollection(name, opts) {
    const scopeCheck = this.checkScope(opts.scope);
    if (!scopeCheck.ok) return scopeCheck;
    const rag = new QdrantRag({
      url: this.url,
      apiKey: this.apiKey,
      embedder: this.embedder,
      collectionName: name,
      timeoutMs: this.timeoutMs,
    });
    const editor = this.buildEditor(rag, this.pickIdStrategy(opts));
    return { ok: true, value: { rag, editor } };
  }
  async deleteCollection(name) {
    try {
      const headers = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) headers['api-key'] = this.apiKey;
      const res = await fetch(`${this.url}/collections/${name}`, {
        method: 'DELETE',
        headers,
      });
      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          error: new RagError(
            `Qdrant delete collection failed: ${body}`,
            'RAG_DELETE_ERROR',
          ),
        };
      }
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_DELETE_ERROR'),
      };
    }
  }
  async listCollections() {
    try {
      const headers = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) headers['api-key'] = this.apiKey;
      const res = await fetch(`${this.url}/collections`, { headers });
      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          error: new RagError(
            `Qdrant list collections failed: ${body}`,
            'RAG_LIST_ERROR',
          ),
        };
      }
      const json = await res.json();
      const names = json.result?.collections?.map((c) => c.name) ?? [];
      return { ok: true, value: names };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(String(err), 'RAG_LIST_ERROR'),
      };
    }
  }
}
//# sourceMappingURL=qdrant-rag-provider.js.map
