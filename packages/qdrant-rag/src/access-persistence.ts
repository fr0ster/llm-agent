import { RagError } from '@mcp-abap-adt/llm-agent';
import { deterministicUUID } from './qdrant-rag.js';

export const ACCESS_COLLECTIONS = [
  'rag_roles',
  'rag_role_assignments',
  'rag_session_bindings',
] as const;
export type AccessPayload = { [key: string]: string | null | undefined };
export function accessCollectionName(catalog: string, name: string): string {
  return catalog === 'rag_collection_catalog' ? name : `${catalog}_${name}`;
}
export function isAccessCollectionName(name: string): boolean {
  return [...ACCESS_COLLECTIONS, 'rag_role_locks'].some(
    (internal) => name === internal || name.endsWith(`_${internal}`),
  );
}
export type QdrantRoleRevision = AccessPayload & {
  role_id: string;
  token: string;
  revision: string;
} & (
    | { state: 'active' }
    | { state: 'deleting'; deletion_token: string }
    | { state: 'deleted' }
  );

function roleRevision(
  payload: AccessPayload,
  roleId: string,
  revision: number,
): QdrantRoleRevision {
  if (payload.role_id !== roleId || typeof payload.token !== 'string')
    throw new QdrantAccessRefusal('Invalid role identity');
  const base = {
    ...payload,
    role_id: roleId,
    token: payload.token,
    revision: String(revision),
  };
  const state =
    payload.state ?? (payload.tombstone === 'true' ? 'deleting' : 'active');
  if (state === 'active') return { ...base, state };
  if (state === 'deleted') return { ...base, state };
  if (state === 'deleting')
    return {
      ...base,
      state,
      deletion_token: payload.deletion_token ?? payload.token,
    };
  throw new QdrantAccessRefusal('Invalid role state');
}

type Point = { id: string; payload?: AccessPayload };
type Request = (path: string, init?: RequestInit) => Promise<Response>;
/** A definite access refusal. */
export class QdrantAccessRefusal extends RagError {
  constructor(message: string) {
    super(message, 'RAG_ACCESS_STORE_ERROR');
  }
}

/** Access operations use the same persisted ids, strong writes and all-replica reads. */
export class QdrantAccessPersistence {
  constructor(
    private readonly request: Request,
    readonly catalog: string,
  ) {}

  private async checked(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.request(path, init);
    if (!response.ok)
      throw new RagError(
        `Qdrant access request failed: HTTP ${response.status} ${await response.text()}`,
        'RAG_ACCESS_STORE_ERROR',
      );
    return response;
  }

  async initialize(): Promise<void> {
    // Older servers may silently ignore update_mode. Never let that become an overwrite binding.
    const version = (await (await this.checked('/')).json()) as {
      version?: string;
    };
    const match = version.version?.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
    if (
      !match ||
      Number(match[1]) < 1 ||
      (Number(match[1]) === 1 && Number(match[2]) < 17)
    ) {
      throw new RagError(
        'RAG access persistence requires Qdrant >= 1.17.0 (insert_only)',
        'RAG_ACCESS_STORE_ERROR',
      );
    }
    for (const name of [
      this.catalog,
      ...ACCESS_COLLECTIONS.map((name) =>
        accessCollectionName(this.catalog, name),
      ),
    ]) {
      let response = await this.request(`/collections/${name}`);
      if (response.status === 404) {
        const created = await this.request(`/collections/${name}`, {
          method: 'PUT',
          body: JSON.stringify({
            vectors: { size: 1, distance: 'Dot' },
            replication_factor: 1,
            write_consistency_factor: 1,
          }),
        });
        // A different instance may have initialized it concurrently.
        if (!created.ok && created.status !== 409)
          throw new RagError(
            `Qdrant access collection creation failed: HTTP ${created.status}`,
            'RAG_ACCESS_STORE_ERROR',
          );
        response = await this.request(`/collections/${name}`);
      }
      if (!response.ok)
        throw new RagError(
          `Qdrant access collection inspection failed: HTTP ${response.status}`,
          'RAG_ACCESS_STORE_ERROR',
        );
      const info = (await response.json()) as {
        result?: {
          payload_schema?: { role_id?: { data_type?: string } };
          config?: {
            params?: {
              replication_factor?: number;
              write_consistency_factor?: number;
            };
          };
        };
      };
      const params = info.result?.config?.params;
      if (
        typeof params?.replication_factor !== 'number' ||
        !Number.isSafeInteger(params.replication_factor) ||
        params.replication_factor < 1 ||
        params.write_consistency_factor !== params.replication_factor
      ) {
        throw new RagError(
          `Qdrant access collection '${name}' requires write_consistency_factor = replication_factor`,
          'RAG_ACCESS_STORE_ERROR',
        );
      }
      if (
        name === this.catalog &&
        info.result?.payload_schema?.role_id?.data_type !== 'keyword'
      ) {
        await this.checked(`/collections/${name}/index?wait=true`, {
          method: 'PUT',
          body: JSON.stringify({
            field_name: 'role_id',
            field_schema: 'keyword',
          }),
        });
      }
    }
  }

  async read(
    collection: string,
    key: string,
  ): Promise<AccessPayload | undefined> {
    collection = accessCollectionName(this.catalog, collection);
    const response = await this.checked(
      `/collections/${collection}/points?consistency=all`,
      {
        method: 'POST',
        body: JSON.stringify({
          ids: [await deterministicUUID(key)],
          with_payload: true,
          with_vector: false,
        }),
      },
    );
    const body = (await response.json()) as { result?: Point[] };
    if (!Array.isArray(body.result))
      throw new RagError(
        'Invalid Qdrant access read',
        'RAG_ACCESS_STORE_ERROR',
      );
    const point = body.result[0];
    if (point && !point.payload)
      throw new RagError(
        'Missing Qdrant access payload',
        'RAG_ACCESS_STORE_ERROR',
      );
    return point?.payload;
  }

  async rows(collection: string): Promise<AccessPayload[]> {
    if (collection !== this.catalog)
      collection = accessCollectionName(this.catalog, collection);
    const rows: AccessPayload[] = [];
    let offset: string | number | null = null;
    do {
      const response = await this.checked(
        `/collections/${collection}/points/scroll?consistency=all`,
        {
          method: 'POST',
          body: JSON.stringify({
            limit: 256,
            with_payload: true,
            with_vector: false,
            ...(offset === null ? {} : { offset }),
          }),
        },
      );
      const body = (await response.json()) as {
        result?: {
          points?: Point[];
          next_page_offset?: string | number | null;
        };
      };
      if (!Array.isArray(body.result?.points))
        throw new RagError(
          'Invalid Qdrant access scroll',
          'RAG_ACCESS_STORE_ERROR',
        );
      for (const point of body.result.points) {
        if (!point.payload)
          throw new RagError(
            'Missing Qdrant access payload',
            'RAG_ACCESS_STORE_ERROR',
          );
        rows.push(point.payload);
      }
      offset = body.result.next_page_offset ?? null;
    } while (offset !== null);
    return rows;
  }

  async insert(
    collection: string,
    key: string,
    payload: AccessPayload,
  ): Promise<void> {
    collection = accessCollectionName(this.catalog, collection);
    await this.checked(
      `/collections/${collection}/points?wait=true&ordering=strong`,
      {
        method: 'PUT',
        body: JSON.stringify({
          points: [{ id: await deterministicUUID(key), vector: [1], payload }],
          update_mode: 'insert_only',
        }),
      },
    );
  }

  async remove(collection: string, key: string): Promise<void> {
    collection = accessCollectionName(this.catalog, collection);
    await this.checked(
      `/collections/${collection}/points/delete?wait=true&ordering=strong`,
      {
        method: 'POST',
        body: JSON.stringify({ points: [await deterministicUUID(key)] }),
      },
    );
  }

  async patch(
    collection: string,
    key: string,
    payload: AccessPayload,
  ): Promise<void> {
    collection = accessCollectionName(this.catalog, collection);
    await this.checked(
      `/collections/${collection}/points/payload?wait=true&ordering=strong`,
      {
        method: 'POST',
        body: JSON.stringify({
          points: [await deterministicUUID(key)],
          payload,
        }),
      },
    );
  }

  async removeWhere(
    collection: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<void> {
    collection = accessCollectionName(this.catalog, collection);
    await this.checked(
      `/collections/${collection}/points/delete?wait=true&ordering=strong`,
      {
        method: 'POST',
        body: JSON.stringify({
          filter: {
            must: Object.entries(fields).map(([key, value]) => ({
              key,
              match: { value },
            })),
          },
        }),
      },
    );
  }

  /** Immutable revision points fence every role transition across instances. */
  async roleState(roleId: string): Promise<QdrantRoleRevision | undefined> {
    let current = await this.read('rag_roles', roleId);
    if (!current) return undefined;
    let revision = 0;
    for (;;) {
      const next = await this.read(
        'rag_roles',
        JSON.stringify([roleId, revision + 1]),
      );
      if (!next) return roleRevision(current, roleId, revision);
      if (next.role_id !== roleId || next.revision !== String(revision + 1))
        throw new QdrantAccessRefusal('Invalid role revision');
      current = next;
      revision += 1;
    }
  }

  async transitionRole(
    current: QdrantRoleRevision,
    state: 'active' | 'deleting' | 'deleted',
    changes: AccessPayload = {},
  ): Promise<QdrantRoleRevision | undefined> {
    if (
      (current.state === 'active' && state !== 'deleting') ||
      (current.state === 'deleted' && state !== 'active')
    )
      throw new QdrantAccessRefusal('Invalid role transition');
    const roleId = current.role_id;
    const revision = Number(current.revision) + 1;
    if (
      typeof roleId !== 'string' ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      throw new QdrantAccessRefusal('Invalid role revision');
    const key = JSON.stringify([roleId, revision]);
    const fence = crypto.randomUUID();
    const next = {
      ...current,
      ...changes,
      state,
      revision: String(revision),
      fence,
    };
    await this.insert('rag_roles', key, next);
    const stored = await this.read('rag_roles', key);
    return stored?.fence === fence
      ? roleRevision(next, roleId, revision)
      : undefined;
  }

  async requireRole(roleId: string): Promise<AccessPayload> {
    const role = await this.roleState(roleId);
    if (
      role?.role_id !== roleId ||
      role.state !== 'active' ||
      typeof role.token !== 'string'
    )
      throw new QdrantAccessRefusal('Role does not exist');
    return role;
  }
}
