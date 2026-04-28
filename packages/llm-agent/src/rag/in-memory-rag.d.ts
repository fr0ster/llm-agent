import type { IQueryEmbedding } from '../interfaces/query-embedding.js';
import type { IRag, IRagBackendWriter } from '../interfaces/rag.js';
import type {
  CallOptions,
  RagMetadata,
  RagResult,
  Result,
} from '../interfaces/types.js';
import { RagError } from '../interfaces/types.js';
import type { IDocumentEnricher, IQueryPreprocessor } from './preprocessor.js';
export interface InMemoryRagConfig {
  /** Cosine similarity above which upsert updates existing record. Default: 0.92 */
  dedupThreshold?: number;
  /** Namespace for this store. Records with different namespace are invisible to query. */
  namespace?: string;
  /** Query preprocessors (translate, expand, etc.). Applied in order before embedding. */
  queryPreprocessors?: IQueryPreprocessor[];
  /** Document enrichers. Applied in order before embedding on upsert. */
  documentEnrichers?: IDocumentEnricher[];
}
export declare class InMemoryRag implements IRag {
  private records;
  private readonly dedupThreshold;
  private readonly namespace?;
  private readonly queryPreprocessors;
  private readonly documentEnrichers;
  constructor(config?: InMemoryRagConfig);
  upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>>;
  query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>>;
  getById(
    id: string,
    _options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>>;
  healthCheck(): Promise<Result<void, RagError>>;
  clear(): void;
  writer(): IRagBackendWriter;
}
//# sourceMappingURL=in-memory-rag.d.ts.map
