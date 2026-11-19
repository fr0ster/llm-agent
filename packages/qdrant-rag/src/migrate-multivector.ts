import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { RagError } from '@mcp-abap-adt/llm-agent';
import {
  assertUserCollection,
  type DenseVectors,
  isMigrationCollection,
  isUnnamed,
  MIGRATION_LOCK_COLLECTION,
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

interface MigrationConnection {
  url: string;
  credential?: IApiKeyCredential;
  signal?: AbortSignal;
}

export type QdrantMultivectorMigrationLockStatus = {
  collection: string;
} & ({ locked: false } | { locked: true; ownerToken: string | null });

export interface QdrantMultivectorMigrationOptions extends MigrationConnection {
  /** If omitted, use the catalog to select managed collections. */
  collection?: string;
  catalogCollection?: string;
  dryRun?: boolean;
  /** Receive the deployment lock state before a dry run inspects collections. */
  onLockStatus?: (status: QdrantMultivectorMigrationLockStatus) => void;
}

export interface QdrantMultivectorMigrationResult {
  collection: string;
  temporaryCollection: string;
  action: 'migrate' | 'resume' | 'already-migrated';
}

const marker = '__rag_multivector_migration_marker__';
const lockPath = collectionPath(MIGRATION_LOCK_COLLECTION);
const lockOwner = /^owner-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
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

class MigrationLockOwnershipError extends RagError {
  constructor(message: string) {
    super(message, 'RAG_MIGRATION_ERROR');
  }
}

class UnconfirmedMigrationWriteError extends RagError {
  constructor(message: string) {
    super(message, 'RAG_MIGRATION_ERROR');
  }
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

function migrationCollectionName(collection: string): string {
  return (
    MIGRATION_PREFIX + createHash('sha256').update(collection).digest('hex')
  );
}

function recoveryVectors(collection: string): Record<string, object> {
  // Sparse vector names are persisted by the collection create request on
  // Qdrant versions before collection metadata. Qdrant uses the names in file
  // paths, so split the entire encoded name into filesystem-safe components.
  const chunks = Buffer.from(collection)
    .toString('base64url')
    .match(/.{1,128}/g);
  return Object.fromEntries(
    (chunks ?? []).map((chunk, index) => [`${marker}${index}.${chunk}`, {}]),
  );
}

interface MutationResponse {
  result?: boolean | { status?: string; operation_id?: number | null } | null;
  status?: 'ok' | { error?: string };
  time?: number;
}

function parseMutationResponse(body: string): MutationResponse | null {
  try {
    return JSON.parse(body) as MutationResponse | null;
  } catch {
    return null;
  }
}

function isDefiniteRejection(
  status: number,
  method: string,
  path: string,
  reply: MutationResponse | null,
): boolean {
  const error =
    typeof reply?.status === 'object' ? reply.status?.error : undefined;
  if (typeof error !== 'string') return false;

  // Duplicate collection creation is rejected before replacing the collection.
  if (
    status === 409 &&
    method === 'PUT' &&
    /^\/collections\/[^/?]+(?:\?|$)/.test(path)
  )
    return (
      error.startsWith('Wrong input: Collection ') &&
      error.endsWith(' already exists!')
    );

  // Actix extractor errors occur before the mutation handler runs. Qdrant can
  // also return 400 or 404 after a partial shard or alias update.
  if (reply?.time !== 0) return false;
  return (
    (status === 400 && /^(Deserialize|Format) error in /.test(error)) ||
    (status === 422 && error.startsWith('Validation error in '))
  );
}

function client(options: MigrationConnection, fence?: () => Promise<void>) {
  return async (
    path: string,
    method = 'GET',
    body?: object,
    {
      allowedStatus,
      shardlessIndex = false,
    }: { allowedStatus?: 404 | 409; shardlessIndex?: boolean } = {},
  ) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.credential)
      headers['api-key'] = await options.credential.secret();
    const url = `${options.url.replace(/\/+$/, '')}${path}`;
    const init = {
      method,
      headers,
      body: body === undefined ? undefined : serialize(body),
    };
    const write =
      method === 'PUT' ||
      method === 'DELETE' ||
      path === '/collections/aliases';
    const pointUpsert = /^\/collections\/[^/]+\/points\?/.test(path);
    const payloadIndex = /^\/collections\/[^/]+\/index\?/.test(path);
    let unconfirmed: UnconfirmedMigrationWriteError | undefined;
    const sendWrite = async () => {
      // Recheck ownership on every attempt, including after Retry-After.
      await fence?.();
      options.signal?.throwIfAborted();
      let rejection: string;
      try {
        // Let an in-flight mutation finish before cancellation releases the lock.
        const sent = await fetch(url, { ...init, redirect: 'manual' });
        if (sent.status === 429) {
          // Qdrant can return 429 after a subset of replicas accepted the write.
          unconfirmed ??= new UnconfirmedMigrationWriteError(
            `Could not confirm ${method} ${path}: HTTP 429`,
          );
          return sent;
        }
        const body = await sent.text();
        const reply = parseMutationResponse(body);
        const applied = reply?.result;
        // Qdrant commits the payload schema before updating shards. With no
        // custom shards, that second step acknowledges without an operation ID.
        const completed =
          pointUpsert || payloadIndex
            ? typeof applied === 'object' &&
              (applied?.status === 'completed' ||
                (payloadIndex &&
                  shardlessIndex &&
                  applied?.status === 'acknowledged' &&
                  applied.operation_id == null))
            : applied === true;
        if (
          sent.ok &&
          sent.status !== 202 &&
          reply?.status === 'ok' &&
          completed
        ) {
          // An identical upsert to the offline backup writes the same values
          // to the same point IDs, even if an earlier attempt arrives later.
          // Recovery copies the same offline data, and success deletes the backup.
          if (
            pointUpsert &&
            path.startsWith(`/collections/${MIGRATION_PREFIX}`)
          )
            unconfirmed = undefined;
          return sent;
        }
        const outcome = `HTTP ${sent.status}: ${body}`;
        if (!isDefiniteRejection(sent.status, method, path, reply))
          throw new Error(outcome);
        if (sent.status === allowedStatus) return sent;
        rejection = outcome;
      } catch (error) {
        unconfirmed = new UnconfirmedMigrationWriteError(
          `${unconfirmed?.message ?? `Could not confirm ${method} ${path}`}: ${String(error)}`,
        );
        throw unconfirmed;
      }
      throw migrationError(`${method} ${path} failed (${rejection})`);
    };
    let response: Response;
    try {
      response = await qdrantFetch(
        url,
        { ...init, signal: options.signal },
        write ? sendWrite : undefined,
      );
    } catch (error) {
      if (!unconfirmed || error === unconfirmed) throw error;
      throw new UnconfirmedMigrationWriteError(
        `${unconfirmed.message}. Request stopped: ${String(error)}`,
      );
    }
    // A successful retry may leave an earlier mutation pending. For example,
    // a late DELETE by name could remove a collection recreated after the retry.
    if (unconfirmed) {
      const outcome = response.ok
        ? 'The retry succeeded'
        : `The retry was rejected with HTTP ${response.status}`;
      throw new UnconfirmedMigrationWriteError(
        `${unconfirmed.message}. ${outcome}. An earlier attempt may still apply`,
      );
    }
    if (!write && !response.ok && response.status !== allowedStatus)
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
  const response = await request(path, 'GET', undefined, {
    allowedStatus: 404,
  });
  return response.ok ? result<CollectionInfo>(response) : undefined;
}

async function readLock(
  request: Client,
): Promise<QdrantMultivectorMigrationLockStatus> {
  const info = await inspect(request, lockPath);
  const collection = MIGRATION_LOCK_COLLECTION;
  if (!info) return { collection, locked: false };
  const names = Object.keys(info.config?.params?.vectors ?? {});
  const ownerToken =
    names.length === 1 ? lockOwner.exec(names[0])?.[1] : undefined;
  return { collection, locked: true, ownerToken: ownerToken ?? null };
}

function describeLock(status: QdrantMultivectorMigrationLockStatus): string {
  if (!status.locked) return `Migration lock "${status.collection}" is absent.`;
  if (!status.ownerToken)
    return `Migration lock "${status.collection}" has an unreadable holder token. Inspect the lock before attempting recovery.`;
  return `Migration lock "${status.collection}" is held by token "${status.ownerToken}". ${releaseInstructions(status.ownerToken)}`;
}

function releaseInstructions(token: string): string {
  return `After confirming no migration or release process is running and all pending Qdrant operations have settled, run qdrant-migrate-multivector --release-lock ${token} against the same deployment if the lock is still held by that token.`;
}

async function requireLock(request: Client, token: string): Promise<void> {
  const lock = await readLock(request);
  if (!lock.locked || lock.ownerToken !== token)
    throw new MigrationLockOwnershipError(
      `Migration lock ownership could not be verified for token "${token}". ${describeLock(lock)}`,
    );
}

async function acquireLock(request: Client, token: string): Promise<void> {
  // Qdrant 1.10–1.17 reject a duplicate collection create with HTTP 409.
  // A named vector stores the owner in the same atomic create on all versions.
  const response = await request(
    `${lockPath}?wait=true`,
    'PUT',
    {
      vectors: { [`owner-${token}`]: { size: 1, distance: 'Dot' } },
      shard_number: 1,
      replication_factor: 1,
    },
    { allowedStatus: 409 },
  );
  if (response.status === 409) {
    throw migrationError(
      `Could not acquire migration lock (HTTP 409). ${describeLock(await readLock(request))}`,
    );
  }
}

/** Release a lock once other migration and release processes have stopped and pending Qdrant writes have settled. */
export async function releaseQdrantMultivectorMigrationLock(
  options: MigrationConnection,
  token: string,
): Promise<void> {
  const read = client(options);
  const request = client(options, () => requireLock(read, token));
  try {
    await request(`${lockPath}?wait=true`, 'DELETE');
  } catch (error) {
    if (!(error instanceof UnconfirmedMigrationWriteError)) throw error;
    throw migrationError(
      `${error.message}. Release of migration lock "${MIGRATION_LOCK_COLLECTION}" for token "${token}" is unconfirmed. ${releaseInstructions(token)}`,
    );
  }
}

async function readRecovery(request: Client, temporaryCollection: string) {
  const backup = await inspect(request, collectionPath(temporaryCollection));
  const names = Object.keys(
    backup?.config?.params?.sparse_vectors ?? {},
  ).filter((name) => name.startsWith(marker));
  const encoded = names
    .map((name) => name.slice(marker.length).split('.'))
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, chunk]) => chunk)
    .join('');
  const collection = Buffer.from(encoded, 'base64url').toString();
  if (
    !backup ||
    !collection ||
    isMigrationCollection(collection) ||
    migrationCollectionName(collection) !== temporaryCollection ||
    !isDeepStrictEqual(
      new Set(names),
      new Set(Object.keys(recoveryVectors(collection))),
    )
  )
    throw migrationError(
      `Cannot read the original collection name from "${temporaryCollection}"`,
    );
  return { collection, backup };
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
  temporaryFor?: string,
) {
  const { params, optimizer_config, ...config } = info.config;
  const sparse = Object.fromEntries(
    Object.entries(params.sparse_vectors ?? {}).filter(
      ([name]) => !name.startsWith(marker),
    ),
  );
  if (temporaryFor) Object.assign(sparse, recoveryVectors(temporaryFor));
  await request(path, 'PUT', {
    ...config,
    ...params,
    vectors: multivectors(params.vectors),
    optimizers_config: optimizer_config,
    sparse_vectors: Object.keys(sparse).length ? sparse : undefined,
  });
}

async function createPayloadIndexes(
  request: Client,
  path: string,
  info: CollectionInfo,
  shardlessIndex: boolean,
) {
  for (const [field_name, { data_type, params }] of Object.entries(
    info.payload_schema ?? {},
  )) {
    await request(
      `${path}/index?wait=true`,
      'PUT',
      { field_name, field_schema: params ?? data_type },
      { shardlessIndex },
    );
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

async function copyShardKeys(request: Client, from: string, to: string) {
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
  }
  return [...source.keys()];
}

async function copyCollection(
  request: Client,
  from: string,
  to: string,
  info: CollectionInfo,
) {
  const shardKeys =
    info.config.params.sharding_method?.toLowerCase() === 'custom'
      ? await copyShardKeys(request, from, to)
      : [undefined];
  await createPayloadIndexes(request, to, info, shardKeys.length === 0);
  for (const shardKey of shardKeys)
    await copyAndVerify(request, from, to, shardKey);
}

async function migrateOne(
  request: Client,
  collection: string,
  dryRun: boolean | undefined,
  backup?: CollectionInfo,
): Promise<QdrantMultivectorMigrationResult> {
  assertUserCollection(collection);
  const temporaryCollection = migrationCollectionName(collection);
  const original = collectionPath(collection);
  const temporary = collectionPath(temporaryCollection);
  const source = await inspect(request, original);
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
    Object.keys(source?.config.params.sparse_vectors ?? {}).some((name) =>
      name.startsWith(marker),
    ) ||
    (backup && !isMultivector(backup.config.params.vectors))
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
    if (!backup) {
      await create(request, temporary, source, collection);
      await readRecovery(request, temporaryCollection);
    }
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
    await create(request, original, saved);
  await copyCollection(request, temporary, original, saved);
  await moveAliases(request, temporaryCollection, collection);
  await request(temporary, 'DELETE');
  return report;
}

/** Resume interrupted migrations, then migrate the selected offline collections. */
export async function migrateQdrantMultivectors(
  options: QdrantMultivectorMigrationOptions,
): Promise<QdrantMultivectorMigrationResult[]> {
  const request = client(options);
  if (options.dryRun) {
    const lock = await readLock(request);
    options.onLockStatus?.(lock);
    return migrateCollections(request, options);
  }

  const token = randomUUID();
  let acquired = false;
  let failure: Error | undefined;
  try {
    await acquireLock(request, token);
    acquired = true;
    await requireLock(request, token);
    const reports = await migrateCollections(
      client(options, () => requireLock(request, token)),
      options,
    );
    options.signal?.throwIfAborted();
    return reports;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    if (!(error instanceof UnconfirmedMigrationWriteError)) throw error;
    const outcome = acquired ? 'was retained' : 'may still be acquired';
    throw migrationError(
      `${error.message}. Migration lock "${MIGRATION_LOCK_COLLECTION}" ${outcome} for token "${token}". ${releaseInstructions(token)}`,
    );
  } finally {
    if (acquired && !(failure instanceof UnconfirmedMigrationWriteError)) {
      await releaseQdrantMultivectorMigrationLock(
        { ...options, signal: undefined },
        token,
      ).catch((error: Error) => {
        if (error instanceof MigrationLockOwnershipError) return;
        if (failure)
          throw migrationError(
            `${failure.message}. Lock release failed: ${String(error)}`,
          );
        throw error;
      });
    }
  }
}

async function migrateCollections(
  request: Client,
  options: QdrantMultivectorMigrationOptions,
): Promise<QdrantMultivectorMigrationResult[]> {
  const { collections } = await result<{ collections: { name: string }[] }>(
    await request('/collections'),
  );
  const reports = new Map<string, QdrantMultivectorMigrationResult>();
  for (const { name } of collections) {
    if (name === MIGRATION_LOCK_COLLECTION || !isMigrationCollection(name))
      continue;
    const { collection, backup } = await readRecovery(request, name);
    reports.set(
      collection,
      await migrateOne(request, collection, options.dryRun, backup),
    );
  }
  const migrateSelected = async (collection: string) => {
    if (!reports.has(collection))
      reports.set(
        collection,
        await migrateOne(request, collection, options.dryRun),
      );
  };
  if (options.collection !== undefined) {
    await migrateSelected(options.collection);
    return [...reports.values()];
  }
  const catalog = collectionPath(
    options.catalogCollection ?? 'rag_collection_catalog',
  );
  if (
    options.catalogCollection === undefined &&
    !(await inspect(request, catalog))
  )
    return [...reports.values()];
  for await (const page of pages(request, catalog, false)) {
    for (const { payload } of page) {
      if (typeof payload?.store_name === 'string')
        await migrateSelected(payload.store_name);
    }
  }
  return [...reports.values()];
}
