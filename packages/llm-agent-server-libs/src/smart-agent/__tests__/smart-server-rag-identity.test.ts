import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { test } from 'node:test';
import {
  InMemoryRag,
  InMemoryRagProvider,
  RagAccessDeniedError,
  SimpleRagRegistry,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import {
  fixedCallerResolver,
  testRagAccess,
} from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';
import { ownerBoundQuery } from '@mcp-abap-adt/llm-agent-libs';
import { buildSessionLifecycle, SmartServer } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

function controlledPromise() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

function setup(userId = 'u1') {
  const server = new SmartServer(
    {
      callerResolver: fixedCallerResolver({ userId, isAdmin: false }),
      ragAccess: testRagAccess(),
    },
    constructionSeams,
  );
  const lifecycle = buildSessionLifecycle({
    idleTtlMs: 1000,
    maxSessions: 10,
    cookieName: 'sid',
    mcpClients: [],
    toolsRag: undefined,
    ragRegistry: new SimpleRagRegistry(),
    buildAgent: async () => undefined,
  });
  server['_lifecycle'] = lifecycle;
  return { server, lifecycle };
}

function request(userId = 'u1') {
  const req = new IncomingMessage(new Socket());
  req.headers = { cookie: 'sid=s1', authorization: userId };
  const res = new ServerResponse(req);
  return { req, res };
}

test('a server built without callerResolver fails to start', async () => {
  await assert.rejects(
    async () => {
      // Deliberately exercise a JavaScript consumer omitting the required config.
      const server = new SmartServer(
        // @ts-expect-error Deliberately omit the mandatory resolver.
        Object.assign({}, { ragAccess: testRagAccess() }),
        constructionSeams,
      );
      await server.start();
    },
    { name: 'ServerConfigError' },
  );
});

test('a server built without ragAccess refuses startup', () => {
  assert.throws(
    () => {
      const callerResolver = fixedCallerResolver({
        userId: 'u1',
        isAdmin: false,
      });
      // @ts-expect-error Deliberately omit the mandatory access dependencies.
      new SmartServer({ callerResolver }, constructionSeams);
    },
    { name: 'ServerConfigError' },
  );
});

test('a resolver returning ok:false produces a 403, and acquire is never called', async (t) => {
  const { server, lifecycle } = setup();
  server['cfg'].callerResolver = {
    resolve: async () => ({ ok: false, error: new RagAccessDeniedError() }),
  };
  const acquire = t.mock.method(lifecycle, 'acquire');
  const { req, res } = request();
  await server['_withSession'](req, res, async () =>
    assert.fail('must not serve'),
  );
  assert.equal(res.statusCode, 403);
  assert.equal(acquire.mock.callCount(), 0);
  await lifecycle.disposeAll();
});

for (const concurrent of [false, true]) {
  test(`same cookie resolved as u1 then u2 is refused (concurrent=${concurrent})`, async () => {
    const { server, lifecycle } = setup();
    server['cfg'].callerResolver = {
      resolve: async (_sessionId, headers) => ({
        ok: true,
        value: { userId: String(headers.authorization), isAdmin: false },
      }),
    };
    let entered!: () => void;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = request();
    const pending = server['_withSession'](first.req, first.res, async () => {
      entered();
      if (concurrent) await hold;
    });
    await barrier;
    if (!concurrent) await pending;
    const second = request('u2');
    try {
      await server['_withSession'](second.req, second.res, async () =>
        assert.fail('must not serve u2'),
      );
      assert.equal(second.res.statusCode, 403);
    } finally {
      release();
      await pending;
      await lifecycle.disposeAll();
    }
  });
}

test('resolver, persisted bind, and acquire run in order with the real userId', async (t) => {
  const { server, lifecycle } = setup();
  const order: string[] = [];
  t.mock.method(server['cfg'].callerResolver, 'resolve', async () => {
    order.push('resolve');
    return { ok: true, value: { userId: 'u1', isAdmin: false } };
  });
  const bind = server['cfg'].ragAccess.bindings.bind.bind(
    server['cfg'].ragAccess.bindings,
  );
  t.mock.method(
    server['cfg'].ragAccess.bindings,
    'bind',
    async (sessionId: string, userId: string) => {
      order.push('bind');
      assert.equal(sessionId, 's1');
      assert.equal(userId, 'u1');
      return bind(sessionId, userId);
    },
  );
  const acquire = lifecycle.acquire;
  t.mock.method(
    lifecycle,
    'acquire',
    async (identity: Parameters<typeof acquire>[0]) => {
      order.push('acquire');
      assert.equal(identity.userId, 'u1');
      return acquire(identity);
    },
  );
  const { req, res } = request();
  await server['_withSession'](
    req,
    res,
    async (_graph, _sessionId, _traceId, caller) => {
      assert.equal(caller.userId, 'u1');
    },
  );
  assert.deepEqual(order, ['resolve', 'bind', 'acquire']);
  assert.equal(
    (await server['_sessionMetaStore'].get('s1'))?.userIdentity,
    'u1',
  );
  await lifecycle.disposeAll();
});

for (const failure of [
  'resolve',
  'bind',
  'acquire',
  'handler',
  'metadata',
  'cleanup',
] as const) {
  test(`${failure} throwing produces 403 without fallback`, async (t) => {
    const { server, lifecycle } = setup();
    const refuse = async () => {
      throw new Error('refused');
    };
    if (failure === 'resolve')
      t.mock.method(server['cfg'].callerResolver, 'resolve', refuse);
    if (failure === 'bind')
      t.mock.method(server['cfg'].ragAccess.bindings, 'bind', refuse);
    if (failure === 'acquire') t.mock.method(lifecycle, 'acquire', refuse);
    if (failure === 'metadata')
      t.mock.method(server['_sessionMetaStore'], 'create', refuse);
    if (failure === 'cleanup')
      t.mock.method(server['_sessionMetaStore'], 'touch', refuse);
    const { req, res } = request();
    await server['_withSession'](req, res, async () => {
      if (failure === 'handler') throw new Error('handler refused');
      if (failure !== 'cleanup') assert.fail('must not serve');
    });
    assert.equal(res.statusCode, 403);
    await lifecycle.disposeAll();
  });
}

test('a different user is refused while the first acquire is pending', async (t) => {
  const { server, lifecycle } = setup();
  server['cfg'].callerResolver = {
    resolve: async (_sessionId, headers) => ({
      ok: true,
      value: { userId: String(headers.authorization), isAdmin: false },
    }),
  };
  const entered = controlledPromise();
  const release = controlledPromise();
  const acquire = lifecycle.acquire;
  const calls = t.mock.method(
    lifecycle,
    'acquire',
    async (identity: Parameters<typeof acquire>[0]) => {
      entered.resolve();
      await release.promise;
      return acquire(identity);
    },
  );
  const first = request();
  const pending = server['_withSession'](first.req, first.res, async () => {});
  await entered.promise;
  try {
    const second = request('u2');
    await server['_withSession'](second.req, second.res, async () =>
      assert.fail('must not serve'),
    );
    assert.equal(second.res.statusCode, 403);
    assert.equal(calls.mock.callCount(), 1);
  } finally {
    release.resolve();
    await pending;
    await lifecycle.disposeAll();
  }
});

test('role revoke applies on the next request in the same open session and denies retrieval', async () => {
  const { server, lifecycle } = setup();
  const provider = new InMemoryRagProvider({
    name: 'mem',
    supportedScopes: ['user'],
  });
  await provider.roleAdmin.createRole({ roleId: 'r', name: 'Readers' });
  await provider.roleAdmin.assign('u1', 'r');
  const collection = await provider.createCollection('role-docs', {
    scope: 'user',
    userId: 'owner',
  });
  assert.ok(collection.ok);
  assert.ok((await provider.roleAdmin.bindCollection('role-docs', 'r')).ok);
  server['cfg'].ragAccess = {
    ...server['cfg'].ragAccess,
    roles: provider.roles,
  };
  server['_ragProviderRegistry'].registerProvider(provider);
  server['_globalRagRegistry'] = new SimpleRagRegistry();
  const first = request();
  await server['_withSession'](first.req, first.res, async (graph) => {
    assert.ok(
      graph.ragRegistry?.list().some((row) => row.name === 'role-docs'),
    );
  });
  assert.equal(first.res.statusCode, 200);
  await provider.roleAdmin.revoke('u1', 'r');
  const second = request();
  await server['_withSession'](
    second.req,
    second.res,
    async (graph, _sessionId, _traceId, caller) => {
      assert.equal(
        graph.ragRegistry?.list().some((row) => row.name === 'role-docs'),
        false,
      );
      const result = await ownerBoundQuery(
        {
          name: 'role-docs',
          owner: { scope: 'user', userId: 'owner' },
          rag: collection.value.rag,
        },
        new TextOnlyEmbedding('document'),
        5,
        { caller },
        server['cfg'].ragAccess,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.error instanceof RagAccessDeniedError);
    },
  );
  assert.equal(second.res.statusCode, 200);
  await lifecycle.disposeAll();
});

for (const throws of [false, true]) {
  test(`hydration enforces the server decision (throws=${throws})`, async () => {
    const { server, lifecycle } = setup();
    const globals = new SimpleRagRegistry();
    globals.register('documents', new InMemoryRag(), undefined, {
      scope: 'global',
      displayName: 'Documents',
    });
    server['_globalRagRegistry'] = globals;
    server['cfg'].ragAccess.decision.canRead = async () => {
      if (throws) throw new Error('decision unavailable');
      return false;
    };
    const { req, res } = request();
    await server['_withSession'](req, res, async (graph) => {
      assert.equal(throws, false);
      assert.deepEqual(graph.ragRegistry?.list(), []);
    });
    assert.equal(res.statusCode, throws ? 403 : 200);
    await lifecycle.disposeAll();
  });
}
