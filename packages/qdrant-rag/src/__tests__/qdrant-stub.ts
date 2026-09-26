import http from 'node:http';

export type StubPoint = {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
};
export type StubRequest = { method: string; path: string; body: unknown };
export type StubCollection = { size: number; points: Map<string, StubPoint> };

/** The Qdrant REST surface the provider uses, with the documented semantics:
 *  a repeated collection PUT is 409, and insert_only skips an existing id. */
export type QdrantStub = {
  readonly baseUrl: string;
  readonly collections: Map<string, StubCollection>;
  readonly requests: StubRequest[];
  failOn?: (r: StubRequest) => boolean;
  /** Runs inside a points PUT to the catalog, before it is applied — a racing writer. */
  beforeCatalogWrite?: () => void;
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
    reply: (status: number, body: unknown) => void,
  ): void => {
    const body = (r.body ?? {}) as Record<string, unknown>;
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
            config: { params: { vectors: { size: c.size } } },
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
      /^\/collections\/([^/]+)\/points(\/scroll|\/delete|\/search)?$/,
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
        const ids = [...c.points.keys()].sort();
        const start =
          body.offset === undefined ? 0 : ids.indexOf(String(body.offset));
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
      if (r.method === 'POST' && action === '/delete') {
        for (const id of (body.points as string[] | undefined) ?? [])
          c.points.delete(id);
        if (body.filter !== undefined) c.points.clear();
        reply(200, { result: { status: 'completed' } });
        return;
      }
      if (r.method === 'POST' && action === '/search') {
        reply(200, { result: [] });
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
      const reply = (status: number, body: unknown): void => {
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
