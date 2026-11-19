import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { RagError } from '@mcp-abap-adt/llm-agent';
import {
  assertUserCollection,
  type DenseVectors,
  isUnnamed,
  MIGRATION_PREFIX,
  maxSim,
  qdrantFetch,
} from './multivector.js';

type JsonValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
type PointId = number | bigint | string;
type Vector = number[] | number[][] | { indices: number[]; values: number[] };
interface Point {
  id: PointId;
  payload?: { [key: string]: JsonValue };
  vector?: number[] | number[][] | Record<string, Vector>;
}

interface CollectionInfo {
  config: {
    params: {
      vectors: DenseVectors;
      sparse_vectors?: Record<string, object> | null;
      shard_number?: number;
      sharding_method?: string | null;
      replication_factor?: number;
      write_consistency_factor?: number;
      on_disk_payload?: boolean;
    };
    hnsw_config?: object;
    optimizer_config?: object;
    wal_config?: object;
    quantization_config?: object | null;
    strict_mode_config?: object | null;
    metadata?: object | null;
  };
  payload_schema?: Record<
    string,
    { data_type: string; params?: object | null }
  >;
}

export interface QdrantMultivectorMigrationOptions {
  url: string;
  credential?: IApiKeyCredential;
  /** If omitted, use the catalog to select managed collections. */
  collection?: string;
  catalogCollection?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface QdrantMultivectorMigrationResult {
  collection: string;
  temporaryCollection: string;
  action: 'migrate' | 'resume' | 'already-migrated';
}

const marker = '__rag_multivector_migration_marker__';
const pageSize = 256;
const json = JSON as JSON & {
  rawJSON(text: string): object;
  parse(
    text: string,
    reviver: (
      key: string,
      value: JsonValue,
      context: { source?: string },
    ) => JsonValue,
  ): object;
};

function migrationError(message: string): RagError {
  return new RagError(message, 'RAG_MIGRATION_ERROR');
}

function serialize(body: object): string {
  return JSON.stringify(body, (_key, value: JsonValue) =>
    typeof value === 'bigint' ? json.rawJSON(String(value)) : value,
  );
}

async function result<T>(response: Response): Promise<T> {
  // Qdrant supports unsigned 64-bit IDs and signed 64-bit payload integers.
  const body = json.parse(
    await response.text(),
    (_key: string, value: JsonValue, context: { source?: string }) =>
      typeof value === 'number' &&
      /^-?\d+$/.test(context.source ?? '') &&
      !Number.isSafeInteger(value)
        ? BigInt(context.source ?? value)
        : value,
  ) as { result: T };
  return body.result;
}

function multivectors(vectors: DenseVectors): DenseVectors {
  if (isUnnamed(vectors)) return { ...vectors, multivector_config: maxSim };
  return Object.fromEntries(
    Object.entries(vectors).map(([name, params]) => [
      name,
      { ...params, multivector_config: maxSim },
    ]),
  );
}

function isMultivector(vectors: DenseVectors): boolean {
  const params = isUnnamed(vectors) ? [vectors] : Object.values(vectors);
  return (
    params.length > 0 &&
    params.every(
      (vector) => vector.multivector_config?.comparator === 'max_sim',
    )
  );
}

function wrap(vector: Vector): Vector {
  return Array.isArray(vector) && typeof vector[0] === 'number'
    ? [vector as number[]]
    : vector;
}

function convert(point: Point): Point {
  const { id, payload, vector } = point;
  return {
    id,
    payload,
    vector: Array.isArray(vector)
      ? (wrap(vector) as number[] | number[][])
      : Object.fromEntries(
          Object.entries(vector ?? {}).map(([name, value]) => [
            name,
            wrap(value),
          ]),
        ),
  };
}

function collectionPath(name: string): string {
  return `/collections/${encodeURIComponent(name)}`;
}

function client(options: QdrantMultivectorMigrationOptions) {
  return async (
    path: string,
    method = 'GET',
    body?: object,
    allowMissing = false,
  ) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.credential)
      headers['api-key'] = await options.credential.secret();
    const response = await qdrantFetch(
      `${options.url.replace(/\/+$/, '')}${path}`,
      {
        method,
        headers,
        signal: options.signal,
        body: body === undefined ? undefined : serialize(body),
      },
    );
    if (!response.ok && !(allowMissing && response.status === 404))
      throw migrationError(
        `${method} ${path} failed (HTTP ${response.status}): ${await response.text()}`,
      );
    return response;
  };
}

type Client = ReturnType<typeof client>;

async function inspect(
  request: Client,
  path: string,
): Promise<CollectionInfo | undefined> {
  const response = await request(path, 'GET', undefined, true);
  return response.ok ? result<CollectionInfo>(response) : undefined;
}

async function* pages(
  request: Client,
  path: string,
  withVector: boolean,
  shardKey?: PointId,
) {
  let offset: PointId | null | undefined;
  do {
    const page = await result<{
      points: Point[];
      next_page_offset?: PointId | null;
    }>(
      await request(`${path}/points/scroll?consistency=all`, 'POST', {
        offset,
        limit: pageSize,
        with_payload: true,
        with_vector: withVector,
        shard_key: shardKey,
      }),
    );
    yield page.points;
    offset = page.next_page_offset;
  } while (offset != null);
}

async function create(
  request: Client,
  path: string,
  info: CollectionInfo,
  temporary: boolean,
) {
  const { params, optimizer_config, ...config } = info.config;
  const { [marker]: _marker, ...sparse } = params.sparse_vectors ?? {};
  await request(path, 'PUT', {
    ...config,
    ...params,
    vectors: multivectors(params.vectors),
    optimizers_config: optimizer_config,
    sparse_vectors: temporary
      ? { ...sparse, [marker]: {} }
      : Object.keys(sparse).length
        ? sparse
        : undefined,
  });
}

async function createPayloadIndexes(
  request: Client,
  path: string,
  info: CollectionInfo,
) {
  for (const [field_name, { data_type, params }] of Object.entries(
    info.payload_schema ?? {},
  )) {
    await request(`${path}/index?wait=true`, 'PUT', {
      field_name,
      field_schema: params ?? data_type,
    });
  }
}

interface Alias {
  alias_name: string;
  collection_name: string;
}

async function aliases(request: Client, path: string): Promise<Alias[]> {
  return (await result<{ aliases: Alias[] }>(await request(`${path}/aliases`)))
    .aliases;
}

async function moveAliases(
  request: Client,
  from: string,
  to: string,
): Promise<void> {
  const current = await aliases(request, collectionPath(from));
  if (current.length === 0) return;
  await request('/collections/aliases', 'POST', {
    actions: current.flatMap(({ alias_name }) => [
      { delete_alias: { alias_name } },
      { create_alias: { alias_name, collection_name: to } },
    ]),
  });
}

function equivalent(
  expected: JsonValue | object | undefined,
  actual: JsonValue | object | undefined,
  vector = false,
): boolean {
  if (isDeepStrictEqual(expected, actual)) return true;
  if (vector && typeof expected === 'number' && typeof actual === 'number')
    return Math.abs(expected - actual) <= 1e-6;
  if (Array.isArray(expected) && Array.isArray(actual))
    return (
      expected.length === actual.length &&
      expected.every((entry: JsonValue, index) =>
        equivalent(entry, actual[index], vector),
      )
    );
  if (
    expected &&
    actual &&
    typeof expected === 'object' &&
    typeof actual === 'object' &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const right = actual as Record<string, JsonValue>;
    return (
      Object.keys(expected).length === Object.keys(right).length &&
      Object.entries(expected).every(
        ([key, value]: [string, JsonValue]) =>
          Object.hasOwn(right, key) && equivalent(value, right[key], vector),
      )
    );
  }
  return false;
}

async function copyAndVerify(
  request: Client,
  from: string,
  to: string,
  shardKey?: PointId,
) {
  let count = 0;
  for await (const page of pages(request, from, true, shardKey)) {
    if (page.length === 0) continue;
    const points = page.map(convert);
    await request(`${to}/points?wait=true&ordering=strong`, 'PUT', {
      points,
      shard_key: shardKey,
    });
    const sample =
      points.length === 1 ? points : [points[0], points[points.length - 1]];
    const read = await result<Point[]>(
      await request(`${to}/points?consistency=all`, 'POST', {
        ids: sample.map(({ id }) => id),
        with_payload: true,
        with_vector: true,
        shard_key: shardKey,
      }),
    );
    const actual = new Map(read.map((point) => [point.id, point]));
    for (const point of sample) {
      const found = actual.get(point.id);
      if (
        !found ||
        !equivalent(point.payload ?? {}, found.payload ?? {}) ||
        !equivalent(point.vector ?? {}, found.vector ?? {}, true)
      )
        throw migrationError(`Point ${point.id} did not verify in ${to}`);
    }
    count += page.length;
  }
  for (const path of [from, to]) {
    const actual = await result<{ count: number }>(
      await request(`${path}/points/count`, 'POST', {
        exact: true,
        shard_key: shardKey,
      }),
    );
    if (actual.count !== count)
      throw migrationError(`Point count did not verify in ${path}`);
  }
}

interface Shard {
  shard_id: number;
  shard_key?: PointId | null;
}

async function shardGroups(request: Client, path: string) {
  const cluster = await result<{
    peer_id: PointId;
    local_shards: Shard[];
    remote_shards: (Shard & { peer_id: PointId })[];
  }>(await request(`${path}/cluster`));
  const groups = new Map<PointId, Map<number, Set<PointId>>>();
  for (const shard of [
    ...cluster.local_shards.map((shard) => ({
      ...shard,
      peer_id: cluster.peer_id,
    })),
    ...cluster.remote_shards,
  ]) {
    if (shard.shard_key == null) continue;
    const shards =
      groups.get(shard.shard_key) ?? new Map<number, Set<PointId>>();
    const peers = shards.get(shard.shard_id) ?? new Set<PointId>();
    peers.add(shard.peer_id);
    shards.set(shard.shard_id, peers);
    groups.set(shard.shard_key, shards);
  }
  return groups;
}

async function copyCollection(
  request: Client,
  from: string,
  to: string,
  info: CollectionInfo,
) {
  if (info.config.params.sharding_method?.toLowerCase() !== 'custom') {
    await copyAndVerify(request, from, to);
    return;
  }
  const source = await shardGroups(request, from);
  const target = await shardGroups(request, to);
  for (const key of target.keys())
    if (!source.has(key))
      throw migrationError(`Unexpected shard key ${key} in ${to}`);
  for (const [shard_key, shards] of source) {
    const replicas = [...shards.values()];
    const replication_factor = replicas[0].size;
    const existing = target.get(shard_key);
    if (
      replicas.some((peers) => peers.size !== replication_factor) ||
      (existing &&
        (existing.size !== shards.size ||
          [...existing.values()].some(
            (peers) => peers.size !== replication_factor,
          )))
    )
      throw migrationError(
        `Inconsistent replication for shard key ${shard_key}`,
      );
    if (!existing)
      await request(`${to}/shards`, 'PUT', {
        shard_key,
        shards_number: shards.size,
        replication_factor,
        placement: [...new Set(replicas.flatMap((peers) => [...peers]))],
      });
    await copyAndVerify(request, from, to, shard_key);
  }
}

async function migrateOne(
  request: Client,
  collection: string,
  dryRun: boolean | undefined,
): Promise<QdrantMultivectorMigrationResult> {
  assertUserCollection(collection);
  const temporaryCollection =
    MIGRATION_PREFIX + createHash('sha256').update(collection).digest('hex');
  const original = collectionPath(collection);
  const temporary = collectionPath(temporaryCollection);
  const [source, backup] = await Promise.all([
    inspect(request, original),
    inspect(request, temporary),
  ]);
  if (
    source &&
    (await aliases(request, original)).some(
      ({ collection_name }) => collection_name !== collection,
    )
  )
    throw migrationError(
      `Use the physical collection name instead of the alias "${collection}"`,
    );
  if (
    source?.config.params.sparse_vectors?.[marker] ||
    (backup &&
      (!backup.config.params.sparse_vectors?.[marker] ||
        !isMultivector(backup.config.params.vectors)))
  )
    throw migrationError(
      `Qdrant migration collection name collision for "${collection}"`,
    );
  if (!source && !backup)
    throw migrationError(`Qdrant collection "${collection}" does not exist`);
  const action = backup
    ? 'resume'
    : source && isMultivector(source.config.params.vectors)
      ? 'already-migrated'
      : 'migrate';
  const report = {
    collection,
    temporaryCollection,
    action,
  } satisfies QdrantMultivectorMigrationResult;
  if (action === 'already-migrated') return report;
  if (dryRun) return report;

  if (source && !isMultivector(source.config.params.vectors)) {
    if (!backup) await create(request, temporary, source, true);
    await createPayloadIndexes(request, temporary, source);
    await copyCollection(request, original, temporary, source);
    await moveAliases(request, collection, temporaryCollection);
    await request(original, 'DELETE');
  }

  const saved = await inspect(request, temporary);
  if (!saved)
    throw migrationError(
      `Verified migration copy "${temporaryCollection}" is missing`,
    );
  if (!source || !isMultivector(source.config.params.vectors))
    await create(request, original, saved, false);
  await createPayloadIndexes(request, original, saved);
  await copyCollection(request, temporary, original, saved);
  await moveAliases(request, temporaryCollection, collection);
  await request(temporary, 'DELETE');
  return report;
}

/** Migrate an offline collection or each collection registered in the RAG catalog. */
export async function migrateQdrantMultivectors(
  options: QdrantMultivectorMigrationOptions,
): Promise<QdrantMultivectorMigrationResult[]> {
  const request = client(options);
  if (options.collection !== undefined)
    return [await migrateOne(request, options.collection, options.dryRun)];
  const reports: QdrantMultivectorMigrationResult[] = [];
  const registered = new Set<string>();
  for await (const page of pages(
    request,
    collectionPath(options.catalogCollection ?? 'rag_collection_catalog'),
    false,
  )) {
    for (const { payload } of page) {
      if (
        typeof payload?.store_name !== 'string' ||
        registered.has(payload.store_name)
      )
        continue;
      registered.add(payload.store_name);
      reports.push(
        await migrateOne(request, payload.store_name, options.dryRun),
      );
    }
  }
  return reports;
}
