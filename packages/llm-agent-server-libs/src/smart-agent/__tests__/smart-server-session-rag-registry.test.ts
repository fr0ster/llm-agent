import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type IEmbedder,
  InMemoryRag,
  type IRagProvider,
  type IRagProviderRegistry,
  type IRagRegistry,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import type {
  SessionGraph,
  SessionGraphIdentity,
} from '@mcp-abap-adt/llm-agent-libs';
import { makeLlm as makeTestLlm } from '@mcp-abap-adt/llm-agent-libs/testing';
import { SmartServer, type SmartServerConfig } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

const stubEmbedder = {
  embed: async () => ({ vector: [0] }),
} as unknown as IEmbedder;
const cfg = {
  skipModelValidation: true,
  llm: { main: { provider: 'openai', model: 'gpt-4o' } },
} as unknown as SmartServerConfig;

interface Internals {
  _globalRagRegistry: IRagRegistry;
  _ragProviderRegistry: IRagProviderRegistry;
  _sessionRagRegistry: (
    identity: SessionGraphIdentity,
  ) => Promise<IRagRegistry>;
  _lifecycle?: {
    acquire: (sessionId: string) => Promise<SessionGraph>;
    release: (sessionId: string, graph?: SessionGraph) => void;
  };
}

/** The real per-session ragRegistry a built session's SmartAgent holds. */
function sessionRagRegistryOf(graph: SessionGraph): IRagRegistry {
  const agentInternals = graph.agent as unknown as {
    deps: { ragRegistry: IRagRegistry };
  };
  return agentInternals.deps.ragRegistry;
}

/** A real, listening SmartServer (loopback only, OS-assigned port 0),
 *  wired with the same stub LLM the config-reload suite uses, so the DEFAULT
 *  `flat` pipeline really calls `SmartAgentBuilder.build()` per session — the
 *  same path a real request takes (`_withSession` → `lifecycle.acquire`). */
async function startTestServer(
  extraCfg: Record<string, unknown> = {},
): Promise<{
  server: SmartServer;
  internals: Internals;
  close: () => Promise<void>;
}> {
  const server = new SmartServer(
    {
      host: '127.0.0.1',
      port: 0,
      skipModelValidation: true,
      llm: { model: 'test-model' },
      ...extraCfg,
    } as unknown as SmartServerConfig,
    {
      ...constructionSeams,
      makeLlm: async (llmCfg: { model?: string }) => ({
        ...makeTestLlm([{ content: 'ok' }]),
        model: llmCfg.model ?? 'stub',
      }),
    },
  );
  const handle = await server.start();
  return {
    server,
    internals: server as unknown as Internals,
    close: () => handle.close(),
  };
}

test('every session gets its own registry, seeded with the deployment’s globals', async () => {
  const server = new SmartServer(cfg, {
    ...constructionSeams,
    embedder: stubEmbedder,
  });
  const built = await server._buildEmbeddedAgent();
  try {
    const internals = server as unknown as Internals;
    const kb = new InMemoryRag();
    internals._globalRagRegistry.register('kb', kb, undefined, {
      displayName: 'kb',
      scope: 'global',
    });

    const a = await internals._sessionRagRegistry({ sessionId: 'a' });
    const b = await internals._sessionRagRegistry({ sessionId: 'b' });
    assert.notEqual(a, b);
    assert.notEqual(a, internals._globalRagRegistry);
    assert.equal(a.get('kb', 'global'), kb);

    a.register('mine', new InMemoryRag(), undefined, {
      displayName: 'mine',
      scope: 'session',
      sessionId: 'a',
    });
    assert.equal(
      b.get('mine'),
      undefined,
      'one session’s collection is absent from another’s registry',
    );
    assert.equal(
      internals._globalRagRegistry.get('mine'),
      undefined,
      'and from the deployment’s',
    );
  } finally {
    await built.close();
  }
});

test('wiring: two real sessions get distinct RAG registries, neither the shared global (pins ragRegistryFactory)', async () => {
  // Reverting smart-server.ts to `ragRegistry: globalRagRegistry` (instead of
  // `ragRegistryFactory: (identity) => this._sessionRagRegistry(identity)`)
  // would make SessionGraphFactory hand every session the SAME shared
  // registry — this test drives the server's OWN session path (the same
  // `lifecycle.acquire` a real request uses), not the private
  // `_sessionRagRegistry` helper directly, so that regression is caught here.
  const { internals, close } = await startTestServer();
  try {
    const kb = new InMemoryRag();
    internals._globalRagRegistry.register('kb', kb, undefined, {
      displayName: 'kb',
      scope: 'global',
    });

    const graphA = await internals._lifecycle?.acquire('sess-wire-a');
    const graphB = await internals._lifecycle?.acquire('sess-wire-b');
    assert.ok(graphA && graphB, 'both sessions built');
    try {
      const regA = sessionRagRegistryOf(graphA);
      const regB = sessionRagRegistryOf(graphB);
      assert.notEqual(regA, regB, 'each session got its own registry');
      assert.notEqual(
        regA,
        internals._globalRagRegistry,
        'never the shared deployment registry itself',
      );
      assert.notEqual(regB, internals._globalRagRegistry);
      assert.equal(
        regA.get('kb', 'global'),
        kb,
        'the global is still seeded by reference',
      );
    } finally {
      internals._lifecycle?.release('sess-wire-a', graphA);
      internals._lifecycle?.release('sess-wire-b', graphB);
    }
  } finally {
    await close();
  }
});

test('wiring: a real session build gets the server’s provider registry, not a fresh empty one', async () => {
  // Reverting the unconditional `builder.setRagProviderRegistry(this._ragProviderRegistry)`
  // in buildBaseBuilder would make build() substitute a fresh, empty
  // SimpleRagProviderRegistry onto the session's own ragRegistry — an adopted
  // collection's deleteCollection would then fail with
  // `DeleteUnsupportedError` ("provider 'stub' is not registered"), even
  // though the provider IS registered on the server. This test proves the
  // delete reaches the real provider through a REAL build.
  const { internals, close } = await startTestServer();
  try {
    const deletedStores: string[] = [];
    const stub = {
      name: 'stub',
      kind: 'vector',
      editable: true,
      supportedScopes: ['global'],
      createCollection: async () => ({
        ok: false,
        error: new RagError('not expected'),
      }),
      describeCollections: async () => ({
        ok: true,
        value: {
          records: [
            { storeName: 'kbstub_00000001', name: 'kbstub', scope: 'global' },
          ],
          rejected: [],
        },
      }),
      openCollection: async () => ({
        ok: true,
        value: { rag: new InMemoryRag() },
      }),
      deleteCollection: async (storeName: string) => {
        deletedStores.push(storeName);
        return { ok: true, value: undefined };
      },
    } as unknown as IRagProvider;
    internals._ragProviderRegistry.registerProvider(stub);

    const graph = await internals._lifecycle?.acquire('sess-provider');
    assert.ok(graph, 'session built');
    try {
      const reg = sessionRagRegistryOf(graph);
      assert.ok(
        reg.get('kbstub', 'global'),
        'hydrated from the server’s own catalogued provider',
      );
      const deleted = await reg.deleteCollection('kbstub', 'global');
      assert.ok(
        deleted.ok,
        `delete must reach the server’s registered provider, not an empty substitute: ${
          deleted.ok ? '' : deleted.error.message
        }`,
      );
      assert.deepEqual(deletedStores, ['kbstub_00000001']);
    } finally {
      internals._lifecycle?.release('sess-provider', graph);
    }
  } finally {
    await close();
  }
});

test('a rejected catalog row is logged by the first session only, not by every session', async () => {
  const server = new SmartServer(cfg, {
    ...constructionSeams,
    embedder: stubEmbedder,
  });
  const built = await server._buildEmbeddedAgent();
  try {
    const internals = server as unknown as Internals & {
      _fileLogger?: { log: (e: { message?: string }) => void };
    };
    const messages: string[] = [];
    internals._fileLogger = { log: (e) => messages.push(e.message ?? '') };
    internals._ragProviderRegistry.registerProvider({
      name: 'rows',
      kind: 'vector',
      editable: true,
      supportedScopes: ['global'],
      createCollection: async () => ({
        ok: false,
        error: new RagError('not expected'),
      }),
      describeCollections: async () => ({
        ok: true,
        value: {
          records: [],
          rejected: [{ storeName: 'junk_0000000009', reason: 'no scope' }],
        },
      }),
      openCollection: async () => ({
        ok: false,
        error: new RagError('not expected'),
      }),
    } as unknown as IRagProvider);

    await internals._sessionRagRegistry({ sessionId: 'a' });
    const afterFirst = messages.filter((m) =>
      m.includes('rag_catalog_row_rejected'),
    ).length;
    assert.equal(afterFirst, 1);
    await internals._sessionRagRegistry({ sessionId: 'b' });
    assert.equal(
      messages.filter((m) => m.includes('rag_catalog_row_rejected')).length,
      1,
      'the second session logs nothing new for the same row',
    );
  } finally {
    await built.close();
  }
});

// NOTE (B26): since D68 the builder wraps no registry store, so no build — a
// session's or the startup one — mutates a registry entry.
// session-lifecycle/__tests__/session-rag-registry.test.ts pins it with a real
// SmartAgentBuilder + withCircuitBreaker() build.
