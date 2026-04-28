import type {
  CallOptions,
  IEmbedder,
  IQueryEmbedding,
  IRag,
  IRagBackendWriter,
  RagMetadata,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { RagError } from '@mcp-abap-adt/llm-agent';
import type { PgVectorRagConfig } from './connection.js';

export type { PgVectorRagConfig };
export interface PgClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount: number;
  }>;
  end(): Promise<void>;
}
export declare class PgVectorRag implements IRag {
  private readonly collectionName;
  private readonly dimension;
  private readonly embedder;
  private readonly autoCreateSchema;
  private readonly clientPromise;
  private schemaReady;
  private schemaPromise?;
  constructor(
    config: PgVectorRagConfig & {
      embedder: IEmbedder;
    },
    injectedClient?: PgClient,
  );
  private createDriverClient;
  ensureSchema(): Promise<void>;
  private maybeEnsureSchema;
  query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>>;
  getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>>;
  healthCheck(): Promise<Result<void, RagError>>;
  upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>>;
  upsertPrecomputed(
    text: string,
    vector: number[],
    metadata: RagMetadata,
  ): Promise<Result<void, RagError>>;
  private upsertKnown;
  writer(): IRagBackendWriter;
}
//# sourceMappingURL=pg-vector-rag.d.ts.map
