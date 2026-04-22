import type {
  IEmbedder,
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import { RagError, type Result } from '../../interfaces/types.js';
import { QdrantRag } from '../qdrant-rag.js';
import { AbstractRagProvider } from './base-provider.js';

export interface QdrantRagProviderConfig {
  name: string;
  url: string;
  apiKey?: string;
  embedder: IEmbedder;
  editable?: boolean;
  timeoutMs?: number;
  supportedScopes?: readonly RagCollectionScope[];
  idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;
}

export class QdrantRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  private readonly url: string;
  private readonly apiKey?: string;
  private readonly embedder: IEmbedder;
  private readonly timeoutMs?: number;

  constructor(cfg: QdrantRagProviderConfig) {
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

  async createCollection(
    name: string,
    opts: {
      scope: RagCollectionScope;
      sessionId?: string;
      userId?: string;
    },
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>> {
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

  async deleteCollection(name: string): Promise<Result<void, RagError>> {
    try {
      const headers: Record<string, string> = {
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

  async listCollections(): Promise<Result<string[], RagError>> {
    try {
      const headers: Record<string, string> = {
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
      const json = (await res.json()) as {
        result?: { collections?: Array<{ name: string }> };
      };
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
