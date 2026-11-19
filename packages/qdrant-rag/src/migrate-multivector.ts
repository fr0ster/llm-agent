import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { RagError } from '@mcp-abap-adt/llm-agent';
import {
  type DenseVectors,
  isMigrationCollection,
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
  payload?: { [key: string]: JsonValue } | null;
  vector?: number[] | number[][] | Record<string, Vector> | null;
  shard_key?: PointId | null;
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

export interface QdrantMultivectorMigrationOptions extends MigrationConnection {
  /** Select one physical collection. */
  collection?: string;
  /** Select physical collections in order. An empty list only recovers interrupted migrations. */
  collections?: readonly string[];
  /** Select from a custom catalog. The default catalog is used when no selector is provided. */
  catalogCollection?: string;
  dryRun?: boolean;
}

export interface QdrantMultivectorMigrationResult {
  collection: string;
  /** The deterministic name of the temporary collection, even when no copy was needed. */
  temporaryCollection: string;
  action: 'migrate' | 'resume' | 'already-migrated' | 'absent';
  /** The original was verified and the temporary collection remains for recovery. */
  temporaryCollectionRetained?: true;
}

export const RAG_MIGRATION_REJECTED = 'RAG_MIGRATION_REJECTED';
export const RAG_MIGRATION_UNCONFIRMED = 'RAG_MIGRATION_UNCONFIRMED';
export const RAG_MIGRATION_VERIFICATION = 'RAG_MIGRATION_VERIFICATION';
export const RAG_MIGRATION_PRECONDITION = 'RAG_MIGRATION_PRECONDITION';

export type QdrantMultivectorMigrationErrorCode =
  | typeof RAG_MIGRATION_REJECTED
  | typeof RAG_MIGRATION_UNCONFIRMED
  | typeof RAG_MIGRATION_VERIFICATION
  | typeof RAG_MIGRATION_PRECONDITION;

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

function migrationError(
  code: QdrantMultivectorMigrationErrorCode,
  message: string,
): RagError {
  return new RagError(message, code);
}

function serialize(body: object): string {
  return JSON.stringify(body, (_key, value: JsonValue) =>
    typeof value === 'bigint' ? json.rawJSON(String(value)) : value,
  );
}

function parseResult<T>(body: string): T {
  // Qdrant supports unsigned 64-bit IDs and signed 64-bit payload integers.
  const reply = json.parse(
    body,
    (_key: string, value: JsonValue, context: { source?: string }) =>
      typeof value === 'number' &&
      /^-?\d+$/.test(context.source ?? '') &&
      !Number.isSafeInteger(value)
        ? BigInt(context.source ?? value)
        : value,
  ) as { status?: string; result?: T } | null;
  if (
    reply?.result == null ||
    (reply.status !== undefined && reply.status !== 'ok')
  )
    throw new Error(`Unexpected Qdrant response: ${body}`);
  return reply.result;
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

function validateCollectionName(collection: string): void {
  if (
    typeof collection !== 'string' ||
    !collection.trim() ||
    isMigrationCollection(collection)
  )
    throw migrationError(
      RAG_MIGRATION_PRECONDITION,
      `Cannot select collection ${JSON.stringify(collection)} for migration. Supply a non-empty physical collection name outside the reserved migration namespace.`,
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

function isAuthorizationDenial(body: string, error?: string): boolean {
  // Actix returns JWT validation errors as plain text.
  if (
    [
      'ExpiredSignature',
      'InvalidSignature',
      'Invalid JWT, stateful validation failed',
    ].includes(body)
  )
    return true;

  // RBAC errors are checked before dispatch. Storage locks can also return
  // 403, including after a payload index schema has been committed.
  return (
    typeof error === 'string' &&
    [
      'Forbidden: Global access is required',
      'Forbidden: Global manage access is required',
      'Forbidden: Manage access for this operation is required',
      'Forbidden: Access to collection ',
      'Forbidden: Write access to collection ',
      'Forbidden: Only points access is allowed for collection ',
      'Forbidden: This operation is not allowed when "payload" restriction is present for collection ',
    ].some((prefix) => error.startsWith(prefix))
  );
}

function rejectionNextStep(
  status: number,
  method: string,
  path: string,
  reply: MutationResponse | null,
  responseBody: string,
): string | undefined {
  const error =
    typeof reply?.status === 'object' ? reply.status?.error : undefined;

  if (
    status === 401 ||
    (status === 403 && isAuthorizationDenial(responseBody, error))
  )
    return 'Fix the API key or its permissions, then rerun the migration.';

  if (typeof error !== 'string') return;
  const nextStep =
    'Correct the request or resolve the conflict, then rerun the migration.';

  // Duplicate collection creation is rejected before replacing the collection.
  if (
    status === 409 &&
    method === 'PUT' &&
    /^\/collections\/[^/?]+(?:\?|$)/.test(path) &&
    error.startsWith('Wrong input: Collection ') &&
    error.endsWith(' already exists!')
  )
    return nextStep;

  // Actix extractor errors occur before the mutation handler runs. Qdrant can
  // also return 400 or 404 after a partial shard or alias update.
  if (reply?.time !== 0) return;
  if (
    (status === 400 && /^(Deserialize|Format) error in /.test(error)) ||
    (status === 422 && error.startsWith('Validation error in '))
  )
    return nextStep;
}

interface MigrationRun {
  backupUpsertThrottled: boolean;
}

interface ReadOptions<T> {
  body?: object;
  allowMissing?: boolean;
  validate: (result: T) => boolean;
}

function client(
  options: MigrationConnection,
  run: MigrationRun,
  collection: string,
) {
  const label = `collection ${JSON.stringify(collection)}`;
  const urlFor = (path: string) => `${options.url.replace(/\/+$/, '')}${path}`;

  async function initFor(method: string, body?: object): Promise<RequestInit> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.credential)
      headers['api-key'] = await options.credential.secret();
    return {
      method,
      headers,
      body: body === undefined ? undefined : serialize(body),
      signal: options.signal,
      redirect: 'manual',
    };
  }

  function rejected(
    operation: string,
    outcome: string,
    nextStep: string,
  ): RagError {
    return migrationError(
      RAG_MIGRATION_REJECTED,
      `${operation} failed (${outcome}) for ${label}. ${nextStep}`,
    );
  }

  function unconfirmed(operation: string, error: Error | string): RagError {
    const outcome =
      error instanceof Error && error.name === 'Error'
        ? error.message
        : String(error);
    return migrationError(
      RAG_MIGRATION_UNCONFIRMED,
      `Could not confirm ${operation}: ${outcome}. Affected ${label}. After all pending Qdrant operations have settled, rerun the same command to resume from the temporary collection if it exists. The data is preserved in the original or its temporary copy.`,
    );
  }

  async function read<T>(
    path: string,
    settings: ReadOptions<T> & { allowMissing: true },
  ): Promise<T | undefined>;
  async function read<T>(path: string, settings: ReadOptions<T>): Promise<T>;
  async function read<T>(
    path: string,
    { body, allowMissing, validate }: ReadOptions<T>,
  ): Promise<T | undefined> {
    const method = body === undefined ? 'GET' : 'POST';
    const operation = `${method} ${path}`;
    try {
      const response = await qdrantFetch(
        urlFor(path),
        await initFor(method, body),
      );
      if (allowMissing && response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      const reply = await response.text();
      if (!response.ok || response.status === 202) {
        const outcome = `HTTP ${response.status}: ${reply}`;
        const nextStep = rejectionNextStep(
          response.status,
          method,
          path,
          parseMutationResponse(reply),
          reply,
        );
        if (nextStep) throw rejected(operation, outcome, nextStep);
        throw new Error(outcome);
      }
      const result = parseResult<T>(reply);
      if (!validate(result))
        throw new Error(`Unexpected Qdrant response: ${reply}`);
      return result;
    } catch (error) {
      if (error instanceof RagError && error.code === RAG_MIGRATION_REJECTED)
        throw error;
      throw unconfirmed(
        operation,
        error instanceof Error ? error : String(error),
      );
    }
  }

  async function write(
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body?: object,
    {
      shardlessIndex = false,
      retryThrottle = false,
      detail,
    }: {
      shardlessIndex?: boolean;
      retryThrottle?: boolean;
      detail?: string;
    } = {},
  ): Promise<void> {
    const operation = `${method} ${path}${detail ? ` (${detail})` : ''}`;
    const pointUpsert = /^\/collections\/[^/]+\/points\?/.test(path);
    const payloadIndex = /^\/collections\/[^/]+\/index\?/.test(path);
    let throttled = false;
    const send: typeof fetch = async (url, init) => {
      options.signal?.throwIfAborted();
      const response = await fetch(url, init);
      if (response.status === 429 && retryThrottle) {
        // Qdrant can throttle after a subset of replicas accepted the write.
        throttled = true;
        run.backupUpsertThrottled = true;
        return response;
      }
      const responseBody = await response.text();
      const reply = parseMutationResponse(responseBody);
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
        response.ok &&
        response.status !== 202 &&
        reply?.status === 'ok' &&
        completed
      )
        return response;
      const outcome = `HTTP ${response.status}: ${responseBody}`;
      const nextStep = rejectionNextStep(
        response.status,
        method,
        path,
        reply,
        responseBody,
      );
      if (nextStep) throw rejected(operation, outcome, nextStep);
      throw new Error(outcome);
    };

    try {
      const url = urlFor(path);
      const init = await initFor(method, body);
      // Only explicitly opted-in mutations may reach the HTTP 429 retry loop.
      if (retryThrottle) await qdrantFetch(url, init, send);
      else await send(url, init);
    } catch (error) {
      if (
        !throttled &&
        error instanceof RagError &&
        error.code === RAG_MIGRATION_REJECTED
      )
        throw error;
      throw unconfirmed(
        operation,
        throttled
          ? `HTTP 429 before retry stopped: ${String(error)}`
          : error instanceof Error
            ? error
            : String(error),
      );
    }
  }

  return { read, write, label };
}

type Client = ReturnType<typeof client>;

function isRecord(value: object | null | undefined): value is object {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isPointId(value: PointId | null | undefined): value is PointId {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  );
}

function isPointPage(points: Point[]): boolean {
  return (
    Array.isArray(points) &&
    points.every((point: Point) => isPointId(point?.id))
  );
}

async function inspect(
  request: Client,
  path: string,
): Promise<CollectionInfo | undefined> {
  return request.read<CollectionInfo>(path, {
    allowMissing: true,
    validate: (info) => {
      const params = info.config?.params;
      const vectors = params?.vectors;
      return (
        params != null &&
        isRecord(vectors) &&
        (isUnnamed(vectors) || Object.values(vectors).every(isRecord)) &&
        (params.sharding_method == null ||
          typeof params.sharding_method === 'string') &&
        (params.sparse_vectors == null || isRecord(params.sparse_vectors)) &&
        (info.payload_schema == null ||
          (isRecord(info.payload_schema) &&
            Object.values(info.payload_schema).every(
              (field) => typeof field?.data_type === 'string',
            )))
      );
    },
  });
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
      RAG_MIGRATION_PRECONDITION,
      `Cannot read the original collection name from "${temporaryCollection}" while checking the recovery marker. Keep the temporary collection and resolve its recovery metadata before rerunning the migration.`,
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
    const page = await request.read<{
      points: Point[];
      next_page_offset?: PointId | null;
    }>(`${path}/points/scroll?consistency=all`, {
      body: {
        offset,
        limit: pageSize,
        with_payload: true,
        with_vector: withVector,
        shard_key: shardKey,
      },
      validate: ({ points, next_page_offset }) =>
        isPointPage(points) &&
        (next_page_offset == null || isPointId(next_page_offset)),
    });
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
  await request.write(path, 'PUT', {
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
    await request.write(
      `${path}/index?wait=true`,
      'PUT',
      { field_name, field_schema: params ?? data_type },
      { shardlessIndex, detail: `payload index ${JSON.stringify(field_name)}` },
    );
  }
}

interface Alias {
  alias_name: string;
  collection_name: string;
}

async function aliases(request: Client, path: string): Promise<Alias[]> {
  return (
    await request.read<{ aliases: Alias[] }>(`${path}/aliases`, {
      validate: ({ aliases }) =>
        Array.isArray(aliases) &&
        aliases.every(
          (alias: Alias) =>
            typeof alias?.alias_name === 'string' &&
            typeof alias.collection_name === 'string',
        ),
    })
  ).aliases;
}

async function moveAliases(
  request: Client,
  from: string,
  to: string,
): Promise<void> {
  const current = await aliases(request, collectionPath(from));
  if (current.length === 0) return;
  // Qdrant's create_alias replaces the target of an existing alias. Each
  // alias stays discoverable on one of the collections if the batch stops.
  await request.write(
    '/collections/aliases',
    'POST',
    {
      actions: current.map(({ alias_name }) => ({
        create_alias: { alias_name, collection_name: to },
      })),
    },
    {
      detail: `move aliases ${current.map(({ alias_name }) => JSON.stringify(alias_name)).join(', ')} from ${JSON.stringify(from)} to ${JSON.stringify(to)}`,
    },
  );
}

function sameVector(expected: Vector, actual: Vector): boolean {
  if (!Array.isArray(expected) || !Array.isArray(actual))
    return isDeepStrictEqual(expected, actual);
  return (
    expected.length === actual.length &&
    expected.every((entry, index) => {
      const found = actual[index];
      // Cosine vectors can round slightly when Qdrant normalizes an upsert.
      if (typeof entry === 'number' && typeof found === 'number')
        return Math.abs(entry - found) <= 1e-6;
      return (
        Array.isArray(entry) && Array.isArray(found) && sameVector(entry, found)
      );
    })
  );
}

function sameVectors(
  expected: Point['vector'],
  actual: Point['vector'],
): boolean {
  if (Array.isArray(expected) || Array.isArray(actual))
    return (
      Array.isArray(expected) &&
      Array.isArray(actual) &&
      sameVector(expected, actual)
    );
  const entries = Object.entries(expected ?? {});
  const target = actual ?? {};
  return (
    entries.length === Object.keys(target).length &&
    entries.every(
      ([name, vector]) =>
        Object.hasOwn(target, name) && sameVector(vector, target[name]),
    )
  );
}

async function copyAndVerify(
  request: Client,
  from: string,
  to: string,
  shardKey?: PointId,
) {
  let count = 0n;
  const shard =
    shardKey === undefined
      ? ''
      : ` in shard key ${JSON.stringify(String(shardKey))}`;
  function verificationError(problem: string, path: string): RagError {
    return migrationError(
      RAG_MIGRATION_VERIFICATION,
      `${problem} in ${path}${shard} while verifying ${request.label}. Keep the original and temporary copies that exist, investigate the mismatch, then rerun the migration.`,
    );
  }

  for await (const page of pages(request, from, true, shardKey)) {
    if (page.length === 0) continue;
    for (const point of page) {
      if ((point.shard_key ?? undefined) !== shardKey)
        throw migrationError(
          RAG_MIGRATION_PRECONDITION,
          `Unexpected shard key ${String(point.shard_key)} on point ${point.id} in ${from}${shard} while copying ${request.label}. Check the collection's shard layout and replica health before rerunning the migration.`,
        );
    }
    const points = page.map(convert);
    await request.write(
      `${to}/points?wait=true&ordering=strong`,
      'PUT',
      { points, shard_key: shardKey },
      {
        // The private backup has no external writers. An identical request
        // replaces the same IDs with the same data in the same shard. A late
        // attempt cannot change the verified copy, which we retain for recovery.
        retryThrottle: to.startsWith(`/collections/${MIGRATION_PREFIX}`),
        detail: shardKey === undefined ? undefined : `shard key ${shardKey}`,
      },
    );
    const read = await request.read<Point[]>(`${to}/points?consistency=all`, {
      body: {
        ids: points.map(({ id }) => id),
        with_payload: true,
        with_vector: true,
        shard_key: shardKey,
      },
      validate: isPointPage,
    });
    const actual = new Map(read.map((point) => [point.id, point]));
    for (const point of points) {
      const found = actual.get(point.id);
      if (
        !found ||
        (found.shard_key ?? undefined) !== shardKey ||
        !isDeepStrictEqual(point.payload ?? {}, found.payload ?? {}) ||
        !sameVectors(point.vector, found.vector)
      )
        throw verificationError(`Point ${point.id} did not verify`, to);
    }
    if (read.length !== points.length)
      throw verificationError(
        `Retrieved ${read.length} points for ${points.length} copied points`,
        to,
      );
    count += BigInt(page.length);
  }
  for (const path of [from, to]) {
    const actual = await request.read<{ count: number | bigint }>(
      `${path}/points/count?consistency=all`,
      {
        body: { exact: true, shard_key: shardKey },
        validate: ({ count }) =>
          (typeof count === 'bigint' || Number.isSafeInteger(count)) &&
          count >= 0,
      },
    );
    if (BigInt(actual.count) !== count)
      throw verificationError(
        `Point count did not verify (expected ${count}, found ${actual.count})`,
        path,
      );
  }
}

interface Shard {
  shard_id: number;
  shard_key?: PointId | null;
}

function isShard(shard: Shard): boolean {
  return (
    Number.isSafeInteger(shard?.shard_id) &&
    (shard.shard_key == null || isPointId(shard.shard_key))
  );
}

async function shardGroups(request: Client, path: string) {
  const cluster = await request.read<{
    peer_id: PointId;
    local_shards: Shard[];
    remote_shards: (Shard & { peer_id: PointId })[];
  }>(`${path}/cluster`, {
    validate: ({ peer_id, local_shards, remote_shards }) =>
      isPointId(peer_id) &&
      Array.isArray(local_shards) &&
      local_shards.every(isShard) &&
      Array.isArray(remote_shards) &&
      remote_shards.every(
        (shard: Shard & { peer_id: PointId }) =>
          isShard(shard) && isPointId(shard.peer_id),
      ),
  });
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
      throw migrationError(
        RAG_MIGRATION_PRECONDITION,
        `Unexpected shard key ${key} in ${to} while preparing to copy ${request.label} from ${from}. Review both shard layouts and resolve the mismatch before rerunning the migration.`,
      );
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
        RAG_MIGRATION_PRECONDITION,
        `Inconsistent replication for shard key ${shard_key} in ${from} or ${to} while preparing to copy ${request.label}. Restore consistent shard replication before rerunning the migration.`,
      );
    if (!existing)
      await request.write(
        `${to}/shards`,
        'PUT',
        {
          shard_key,
          shards_number: shards.size,
          replication_factor,
          placement: [...new Set(replicas.flatMap((peers) => [...peers]))],
        },
        { detail: `shard key ${shard_key}` },
      );
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
  options: QdrantMultivectorMigrationOptions,
  backup?: CollectionInfo,
): Promise<QdrantMultivectorMigrationResult> {
  validateCollectionName(collection);
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
      RAG_MIGRATION_PRECONDITION,
      `Cannot migrate collection "${collection}" because it is an alias. Use the physical collection name and rerun the migration.`,
    );
  if (
    Object.keys(source?.config.params.sparse_vectors ?? {}).some((name) =>
      name.startsWith(marker),
    ) ||
    (backup && !isMultivector(backup.config.params.vectors))
  )
    throw migrationError(
      RAG_MIGRATION_PRECONDITION,
      `Qdrant migration collection name collision for "${collection}" while checking the source and temporary copy "${temporaryCollection}". Preserve both collections and resolve the conflicting migration name or configuration before rerunning.`,
    );
  if (!source && !backup) {
    if (options.collections !== undefined)
      return { collection, temporaryCollection, action: 'absent' };
    throw migrationError(
      RAG_MIGRATION_PRECONDITION,
      `Cannot inspect Qdrant collection "${collection}" for migration because it does not exist. Check the physical collection name or catalog entry and rerun the migration.`,
    );
  }
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
  if (options.dryRun) return report;

  if (source && !isMultivector(source.config.params.vectors)) {
    if (!backup) {
      await create(request, temporary, source, collection);
      await readRecovery(request, temporaryCollection);
    }
    await copyCollection(request, original, temporary, source);
    await moveAliases(request, collection, temporaryCollection);
    await request.write(original, 'DELETE');
  }

  const saved = await inspect(request, temporary);
  if (!saved)
    throw migrationError(
      RAG_MIGRATION_PRECONDITION,
      `Verified migration copy "${temporaryCollection}" is missing while preparing to restore collection "${collection}". Locate and recover the verified temporary copy before rerunning the migration.`,
    );
  if (!source || !isMultivector(source.config.params.vectors))
    await create(request, original, saved);
  await copyCollection(request, temporary, original, saved);
  await moveAliases(request, temporaryCollection, collection);
  return report;
}

/** Resume interrupted migrations, then migrate the selected offline collections. */
export async function migrateQdrantMultivectors(
  options: QdrantMultivectorMigrationOptions,
): Promise<QdrantMultivectorMigrationResult[]> {
  const { collection, collections, catalogCollection } = options;
  if (
    [collection, collections, catalogCollection].filter(
      (selector) => selector !== undefined,
    ).length > 1
  )
    throw migrationError(
      RAG_MIGRATION_PRECONDITION,
      `Select collections for migration using exactly one selector at a time (collection: ${JSON.stringify(collection)}, collections: ${JSON.stringify(collections)}, catalogCollection: ${JSON.stringify(catalogCollection)}). Omit all selectors to use the default catalog.`,
    );
  if (collections !== undefined && !Array.isArray(collections))
    throw migrationError(
      RAG_MIGRATION_PRECONDITION,
      `Cannot select collections for migration from ${JSON.stringify(collections)}. Supply an array of physical collection names.`,
    );
  if (catalogCollection !== undefined)
    validateCollectionName(catalogCollection);
  const run: MigrationRun = { backupUpsertThrottled: false };
  const requestFor = (name: string) => client(options, run, name);
  const reports = await migrateCollections(requestFor, options);
  if (!options.dryRun) {
    // Defer cleanup until all originals in this run have been verified.
    for (const report of reports) {
      if (report.action === 'already-migrated' || report.action === 'absent')
        continue;
      if (run.backupUpsertThrottled) report.temporaryCollectionRetained = true;
      else
        await requestFor(report.collection).write(
          collectionPath(report.temporaryCollection),
          'DELETE',
        );
    }
  }
  return reports;
}

async function migrateCollections(
  requestFor: (collection: string) => Client,
  options: QdrantMultivectorMigrationOptions,
): Promise<QdrantMultivectorMigrationResult[]> {
  const catalogName = options.catalogCollection ?? 'rag_collection_catalog';
  const selected =
    options.collections ??
    (options.collection === undefined ? undefined : [options.collection]);
  const { collections } = await requestFor(
    selected === undefined
      ? catalogName
      : selected.join(', ') || 'all temporary collections',
  ).read<{ collections: { name: string }[] }>('/collections', {
    validate: ({ collections }) =>
      Array.isArray(collections) &&
      collections.every(
        ({ name }: { name: string }) => typeof name === 'string',
      ),
  });
  const reports = new Map<string, QdrantMultivectorMigrationResult>();
  for (const { name } of collections) {
    if (!isMigrationCollection(name)) continue;
    const { collection, backup } = await readRecovery(requestFor(name), name);
    reports.set(
      collection,
      await migrateOne(requestFor(collection), collection, options, backup),
    );
  }
  const migrateSelected = async (collection: string) => {
    if (!reports.has(collection))
      reports.set(
        collection,
        await migrateOne(requestFor(collection), collection, options),
      );
  };
  if (selected !== undefined) {
    for (const collection of selected) await migrateSelected(collection);
    return [...reports.values()];
  }
  const catalog = collectionPath(catalogName);
  const request = requestFor(catalogName);
  if (!(await inspect(request, catalog))) {
    if (options.catalogCollection === undefined) return [...reports.values()];
    throw migrationError(
      RAG_MIGRATION_PRECONDITION,
      `Cannot inspect catalog collection "${catalogName}" for migration because it does not exist. Check the catalog collection name and rerun the migration.`,
    );
  }
  for await (const page of pages(request, catalog, false)) {
    for (const { payload } of page) {
      if (typeof payload?.store_name === 'string')
        await migrateSelected(payload.store_name);
    }
  }
  return [...reports.values()];
}
