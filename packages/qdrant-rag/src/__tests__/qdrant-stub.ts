type StubJson =
  | string
  | number
  | boolean
  | null
  | undefined
  | StubJson[]
  | { [key: string]: StubJson };

import http from 'node:http';

export type StubPoint = {
  id: string;
  vector: number[];
  payload: Record<string, StubJson>;
};
export type StubRequest = { method: string; path: string; body: StubJson };
export type StubCollection = {
  size: number;
  points: Map<string, StubPoint>;
  replicationFactor?: number;
  writeConsistencyFactor?: number;
  payloadSchema?: { [key: string]: { data_type: string } };
};

/** The Qdrant REST surface the provider uses, with the documented semantics:
 *  a repeated collection PUT is 409, and insert_only skips an existing id. */
export type QdrantStub = {
  readonly baseUrl: string;
  readonly collections: Map<string, StubCollection>;
  readonly requests: StubRequest[];
  failOn?: (r: StubRequest) => boolean;
  version?: string;
  /** Runs inside a points PUT to the catalog, before it is applied — a racing writer. */
  beforeCatalogWrite?: () => void;
  /** Runs inside a set-payload request before it is applied — a racing delete. */
  beforePayloadWrite?: () => void;
  /** Runs inside a points retrieve before it is answered — a racing delete. */
  beforePointsRetrieve?: () => void;
  close(): Promise<void>;
};

export async function startQdrantStub(
  catalog = 'rag_collection_catalog',
): Promise<QdrantStub> {
  const collections = new Map<string, StubCollection>();
  const requests: StubRequest[] = [];
  let stub: QdrantStub | undefined;

  const route = (
    r: StubRequest,
    reply: (status: number, body: StubJson) => void,
  ): void => {
    const body = (r.body ?? {}) as Record<string, StubJson>;
    const index = r.path.match(/^\/collections\/([^/]+)\/index$/);
    if (index && r.method === 'PUT') {
      const collection = collections.get(index[1]);
      if (!collection) {
        reply(404, { status: { error: 'Collection missing' } });
        return;
      }
      collection.payloadSchema ??= {};
      collection.payloadSchema[String(body.field_name)] = {
        data_type: String(body.field_schema),
      };
      reply(200, { result: true });
      return;
    }
    if (r.path === '/' && r.method === 'GET') {
      reply(200, { version: stub?.version ?? '1.17.0' });
      return;
    }
    const missing = (name: string): void =>
      reply(404, {
        status: { error: `Collection \`${name}\` doesn't exist!` },
      });
    const coll = r.path.match(/^\/collections\/([^/]+)$/);
    if (coll) {
      const name = coll[1];
      const c = collections.get(name);
      if (r.method === 'GET') {
        if (!c) {
          missing(name);
          return;
        }
        reply(200, {
          result: {
            status: 'green',
            payload_schema: c.payloadSchema ?? {},
            config: {
              params: {
                vectors: { size: c.size },
                replication_factor: c.replicationFactor ?? 1,
                write_consistency_factor: c.writeConsistencyFactor ?? 1,
              },
            },
          },
        });
        return;
      }
      if (r.method === 'PUT') {
        if (c) {
          reply(409, {
            status: { error: `Collection \`${name}\` already exists!` },
          });
          return;
        }
        const vectors = body.vectors as { size: number };
        collections.set(name, { size: vectors.size, points: new Map() });
        reply(200, { result: true });
        return;
      }
      if (r.method === 'DELETE') {
        collections.delete(name);
        reply(200, { result: true });
        return;
      }
    }
    if (r.path === '/collections' && r.method === 'GET') {
      reply(200, {
        result: {
          collections: [...collections.keys()].map((name) => ({ name })),
        },
      });
      return;
    }
    const pts = r.path.match(
      /^\/collections\/([^/]+)\/points(\/scroll|\/delete|\/search|\/payload)?$/,
    );
    if (pts) {
      const name = pts[1];
      const action = pts[2] as string | undefined;
      const c = collections.get(name);
      if (!c) {
        missing(name);
        return;
      }
      if (r.method === 'PUT' && action === undefined) {
        if (name === catalog) stub?.beforeCatalogWrite?.();
        const insertOnly = body.update_mode === 'insert_only';
        for (const p of body.points as StubPoint[]) {
          if (insertOnly && c.points.has(p.id)) continue;
          c.points.set(p.id, p);
        }
        reply(200, { result: { status: 'completed' } });
        return;
      }
      if (r.method === 'POST' && action === undefined) {
        stub?.beforePointsRetrieve?.();
        const ids = body.ids as string[];
        reply(200, {
          result: ids.flatMap((id) => {
            const p = c.points.get(id);
            return p ? [{ id, payload: p.payload }] : [];
          }),
        });
        return;
      }
      if (r.method === 'POST' && action === '/scroll') {
        // Qdrant scrolls in point-id order; the offset is the first id to
        // return (inclusive), the filter is applied inside the scroll.
        const filter = body.filter as QdrantFilter | undefined;
        const ids = [...c.points.keys()]
          .sort()
          .filter(
            (id) =>
              filter === undefined ||
              matchesFilter(c.points.get(id)?.payload ?? {}, filter),
          );
        const first =
          body.offset === undefined
            ? 0
            : ids.findIndex((id) => id >= String(body.offset));
        const start = first === -1 ? ids.length : first;
        const limit = Number(body.limit ?? 10);
        reply(200, {
          result: {
            points: ids
              .slice(start, start + limit)
              .map((id) => ({ id, payload: c.points.get(id)?.payload })),
            next_page_offset: ids[start + limit] ?? null,
          },
        });
        return;
      }
      if (r.method === 'POST' && action === '/payload') {
        // Set payload by point id: keys are merged into an existing point; an
        // id that is not there is a 404 and nothing is created (Qdrant's
        // behaviour: "No point with id ... found").
        stub?.beforePayloadWrite?.();
        const set = (body.payload ?? {}) as Record<string, StubJson>;
        const ids = (body.points as string[] | undefined) ?? [];
        const absent = ids.find((id) => !c.points.has(id));
        if (absent !== undefined) {
          reply(404, {
            status: { error: `Not found: No point with id ${absent} found` },
          });
          return;
        }
        for (const id of ids)
          Object.assign(c.points.get(id)?.payload ?? {}, set);
        reply(200, { result: { status: 'completed' } });
        return;
      }
      if (r.method === 'POST' && action === '/delete') {
        for (const id of (body.points as string[] | undefined) ?? [])
          c.points.delete(id);
        if (body.filter !== undefined) {
          for (const [id, point] of c.points) {
            if (matchesFilter(point.payload, body.filter as QdrantFilter))
              c.points.delete(id);
          }
        }
        reply(200, { result: { status: 'completed' } });
        return;
      }
      if (r.method === 'POST' && action === '/search') {
        // Qdrant's documented search: the filter is applied inside the
        // search, then points are ordered by cosine similarity and cut at
        // `limit` — so the conformance cases see what a real server returns.
        const query = body.vector as number[];
        const filter = body.filter as QdrantFilter | undefined;
        const limit = Number(body.limit ?? 10);
        const hits = [...c.points.values()]
          .filter(
            (p) => filter === undefined || matchesFilter(p.payload, filter),
          )
          .map((p) => ({
            id: p.id,
            score: cosine(query, p.vector),
            payload: p.payload,
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        reply(200, { result: hits });
        return;
      }
    }
    reply(404, { status: { error: 'not found' } });
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const request: StubRequest = {
        method: req.method ?? 'GET',
        path: new URL(req.url ?? '/', 'http://stub').pathname,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(request);
      const reply = (status: number, body: StubJson): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (stub?.failOn?.(request)) {
        reply(500, { status: { error: 'refused by the test' } });
        return;
      }
      route(request, reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null)
    throw new Error('the stub did not bind');
  stub = {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    collections,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
  return stub;
}

// ---------------------------------------------------------------------------
// Filter evaluation, per Qdrant's documented semantics: `must` — every
// condition holds; `should` — at least one holds (when non-empty); `must_not`
// — none holds. A field condition on a missing key does not hold (so under
// `must_not` it does); `range` holds only for a numeric value; `is_empty`
// holds when the key is missing, null or an empty array.
// ---------------------------------------------------------------------------

type QdrantCondition =
  | { key: string; match: { value: string | number | boolean } }
  | { is_empty: { key: string } }
  | { is_null: { key: string } }
  | { key: string; values_count: { gte: number } }
  | {
      key: string;
      range: { gt?: number; gte?: number; lt?: number; lte?: number };
    }
  | QdrantFilter;

export type QdrantFilter = {
  must?: QdrantCondition[];
  should?: QdrantCondition[];
  must_not?: QdrantCondition[];
};

function holds(
  payload: Record<string, StubJson>,
  cond: QdrantCondition,
): boolean {
  if ('is_null' in cond) return payload[cond.is_null.key] === null;
  if ('values_count' in cond) {
    if (!(cond.key in payload)) return false;
    const value = payload[cond.key];
    return (Array.isArray(value) ? value.length : 1) >= cond.values_count.gte;
  }
  if ('is_empty' in cond) {
    const v = payload[cond.is_empty.key];
    return (
      v === undefined || v === null || (Array.isArray(v) && v.length === 0)
    );
  }
  if ('match' in cond) {
    // Qdrant's match.value also matches an element of an array payload value.
    const v = payload[cond.key];
    return Array.isArray(v)
      ? v.includes(cond.match.value)
      : cond.key in payload && v === cond.match.value;
  }
  if ('range' in cond) {
    const v = payload[cond.key];
    if (typeof v !== 'number') return false;
    const { gt, gte, lt, lte } = cond.range;
    return (
      (gt === undefined || v > gt) &&
      (gte === undefined || v >= gte) &&
      (lt === undefined || v < lt) &&
      (lte === undefined || v <= lte)
    );
  }
  return matchesFilter(payload, cond);
}

export function matchesFilter(
  payload: Record<string, StubJson>,
  filter: QdrantFilter,
): boolean {
  if (filter.must && !filter.must.every((c) => holds(payload, c))) return false;
  if (
    filter.should &&
    filter.should.length > 0 &&
    !filter.should.some((c) => holds(payload, c))
  )
    return false;
  if (filter.must_not?.some((c) => holds(payload, c))) return false;
  return true;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
