import { RagError, retryRagThrottle } from '@mcp-abap-adt/llm-agent';

export const MIGRATION_PREFIX = '__rag_multivector_migration__';

export function isMigrationCollection(name: string): boolean {
  return name.startsWith(MIGRATION_PREFIX);
}

export function assertUserCollection(name: string): void {
  if (isMigrationCollection(name))
    throw new RagError(
      'Reserved Qdrant migration collection name',
      'INVALID_COLLECTION_NAME',
    );
}

export const maxSim = { comparator: 'max_sim' };

export function denseVectorConfig(size: number) {
  return { size, distance: 'Cosine', multivector_config: maxSim };
}

export interface DenseVectorParams {
  size: number;
  distance: string;
  multivector_config?: { comparator: string } | null;
}

export type DenseVectors =
  | DenseVectorParams
  | Record<string, DenseVectorParams>;

export function isUnnamed(vectors: DenseVectors): vectors is DenseVectorParams {
  return typeof vectors.size === 'number';
}

export async function collectionVectors(response: Response) {
  const body = (await response.json()) as {
    result: { config: { params: { vectors: DenseVectors } } };
  };
  const vectors = body.result.config.params.vectors;
  const name = isUnnamed(vectors)
    ? undefined
    : vectors.dense
      ? 'dense'
      : Object.keys(vectors)[0];
  const params = isUnnamed(vectors) ? vectors : vectors[name ?? ''];
  return {
    name,
    size: params.size,
    multivector: params.multivector_config?.comparator === 'max_sim',
  };
}

export function singleVectorWriteError(name: string): RagError {
  return new RagError(
    `Qdrant collection "${name}" stores single vectors. Run qdrant-migrate-multivector --collection "${name}" before writing records with multiple fragments.`,
    'UPSERT_ERROR',
  );
}

export function qdrantFetch(url: string, init: RequestInit): Promise<Response> {
  return retryRagThrottle(async () => {
    const response = await fetch(url, init);
    if (response.status === 429) {
      await response.body?.cancel();
      throw response;
    }
    return response;
  }, init.signal ?? undefined);
}
