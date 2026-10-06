/**
 * Spec §10.5.9 V1–V5, V7, V9 — the server fails loud: unreadable state, a
 * persisted collection that cannot be opened, a failed session-meta write, a
 * failed eager tool catalog and an unresolvable stepper role are errors —
 * never an empty bundle, a skipped entry, a dropped claim, a session without
 * its collection, a swallowed write, a startup that carries on or a stub LLM.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CollectionNotFoundError,
  type IMcpClient,
  type IRagEditor,
  type IRagProvider,
  McpError,
  OrchestratorError,
  PIPELINE_FAILURE_CODES,
  type RagCollectionRecord,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import type { KnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import {
  InMemoryRag,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent-rag';
import {
  buildFromComposition,
  type StepperCompositionSpec,
} from '../build-stepper-root.js';
import { ConfigValidationError } from '../config-validator.js';
import { readClaims, STEP_START_ARTIFACT } from '../controller/artifacts.js';
import { readTerminal, writeTerminal } from '../controller/run-scope.js';
import { hydrateBundle, persistBundle } from '../controller/session-bundle.js';
import { buildSessionRagRegistry } from '../session-lifecycle/session-rag-registry.js';
import { InMemorySessionMetaStore } from '../session-meta-store.js';
import { SmartServer } from '../smart-server.js';
import { makeToolsRagHandle } from '../tools-rag-handle.js';
import { httpRequest, makeLlmDeps } from './server-test-helpers.js';

const STATE_CORRUPT = PIPELINE_FAILURE_CODES.STATE_CORRUPT;

/** A knowledge backend over an array, so a test can write a raw row. */
function memBackend() {
  const rows = new Map<
    string,
    { content: string; metadata: Record<string, unknown> }[]
  >();
  const be = {
    put: async (
      sid: string,
      e: { content: string; metadata: Record<string, unknown> },
    ) => {
      const a = rows.get(sid) ?? [];
      a.push(e);
      rows.set(sid, a);
    },
    semanticQuery: async () => [],
    scan: async (sid: string) => rows.get(sid) ?? [],
    deleteSession: async (sid: string) => {
      rows.delete(sid);
    },
  };
  return be as unknown as KnowledgeBackend & typeof be;
}

function corrupt(code: string, ...names: RegExp[]) {
  return (e: unknown) => {
    assert.ok(e instanceof OrchestratorError, `got ${String(e)}`);
    assert.equal(e.code, code);
    for (const n of names) assert.match(e.message, n);
    return true;
  };
}

// ---------------------------------------------------------------------------
// V1 — a persisted collection that cannot be described / opened / adopted
// ---------------------------------------------------------------------------

const SESSION_RECORD: RagCollectionRecord = {
  storeName: 'scratch_00000004',
  name: 'scratch',
  scope: 'session',
  sessionId: 'S',
};

function provider(overrides: Partial<IRagProvider>): IRagProvider {
  return {
    name: 'pg',
    kind: 'vector',
    editable: true,
    supportedScopes: ['session', 'user', 'global'],
    createCollection: async () => ({
      ok: false,
      error: new RagError('not expected'),
    }),
    describeCollections: async () => ({
      ok: true,
      value: { records: [SESSION_RECORD], rejected: [] },
    }),
    openCollection: async () => ({
      ok: true,
      value: { rag: new InMemoryRag(), editor: {} as IRagEditor },
    }),
    ...overrides,
  } as unknown as IRagProvider;
}

function hydrate(p: IRagProvider) {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(p);
  return buildSessionRagRegistry({
    identity: { sessionId: 'S' },
    globals: new SimpleRagRegistry(),
    providers,
  });
}

describe('V1: a persisted collection that cannot be opened fails the session', () => {
  /** A RagError naming the provider, collection and store, the original as cause, its code kept. */
  function wrapping(original: RagError, ...names: RegExp[]) {
    return (e: unknown) => {
      assert.ok(e instanceof RagError, `got ${String(e)}`);
      assert.equal(e.cause, original, 'the provider’s error is the cause');
      assert.equal(e.code, original.code, 'the code is unchanged');
      for (const n of names) assert.match(e.message, n);
      return true;
    };
  }

  it('openCollection ok:false → a RagError naming the collection and the store, the provider’s error as cause', async () => {
    const notFound = new CollectionNotFoundError('elsewhere');
    await assert.rejects(
      hydrate(
        provider({
          openCollection: async () => ({ ok: false, error: notFound }),
        }),
      ),
      wrapping(notFound, /pg/, /'scratch'/, /scratch_00000004/),
    );
  });

  it('openCollection ok:false with a plain RagError (as the shipped providers return) → the collection is named', async () => {
    const plain = new RagError('x', 'RAG_OPEN_ERROR');
    await assert.rejects(
      hydrate(
        provider({
          openCollection: async () => ({ ok: false, error: plain }),
        }),
      ),
      wrapping(plain, /'scratch'/, /scratch_00000004/),
    );
  });

  it('describeCollections ok:false → a RagError naming the provider, its error as cause', async () => {
    const err = new RagError('catalog unreachable', 'RAG_CATALOG_DOWN');
    await assert.rejects(
      hydrate(
        provider({
          describeCollections: async () => ({ ok: false, error: err }),
        }),
      ),
      wrapping(err, /provider 'pg': describe/, /catalog unreachable/),
    );
  });

  it('openCollection throwing → a RagError naming the provider and the store', async () => {
    await assert.rejects(
      hydrate(
        provider({
          openCollection: async () => {
            throw new Error('open boom');
          },
        }),
      ),
      (e: unknown) => {
        assert.ok(e instanceof RagError, `got ${String(e)}`);
        assert.match(e.message, /pg/);
        assert.match(e.message, /scratch_00000004/);
        assert.match(e.message, /open boom/);
        return true;
      },
    );
  });

  it('adopt throwing → its RagError naming the collection', async () => {
    // Two catalogue rows for one session collection name: the second adopt
    // finds the name taken and throws.
    await assert.rejects(
      hydrate(
        provider({
          describeCollections: async () => ({
            ok: true,
            value: {
              records: [
                SESSION_RECORD,
                { ...SESSION_RECORD, storeName: 'scratch_00000005' },
              ],
              rejected: [],
            },
          }),
        }),
      ),
      (e: unknown) => {
        assert.ok(e instanceof RagError, `got ${String(e)}`);
        assert.ok(
          e.cause instanceof RagError,
          'the registry’s error is the cause',
        );
        assert.match(e.message, /'scratch'/);
        assert.match(e.message, /scratch_00000005/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// V2 — a malformed bundle
// ---------------------------------------------------------------------------

describe('V2: a malformed session bundle is STATE_CORRUPT', () => {
  it('the latest bundle line does not parse → STATE_CORRUPT naming the session (not the older bundle)', async () => {
    const be = memBackend();
    await persistBundle(be, 's1', {
      goal: 'older',
      plannerPrivate: '',
      budgets: { stepsUsed: 0, rewindsUsed: 0 },
    });
    await be.put('s1', {
      content: '{not json',
      metadata: { artifactType: 'controller-bundle' },
    });
    await assert.rejects(hydrateBundle(be, 's1'), corrupt(STATE_CORRUPT, /s1/));
  });

  it('a bundle line that is not an object → STATE_CORRUPT', async () => {
    const be = memBackend();
    await be.put('s2', {
      content: '42',
      metadata: { artifactType: 'controller-bundle' },
    });
    await assert.rejects(hydrateBundle(be, 's2'), corrupt(STATE_CORRUPT, /s2/));
  });

  it('a bundle line without goal or budgets ({}) → STATE_CORRUPT', async () => {
    const be = memBackend();
    await be.put('s3', {
      content: '{}',
      metadata: { artifactType: 'controller-bundle' },
    });
    await assert.rejects(
      hydrateBundle(be, 's3'),
      corrupt(STATE_CORRUPT, /s3/, /has no goal or budgets/),
    );
  });
});

// ---------------------------------------------------------------------------
// V3 — a malformed terminal entry
// ---------------------------------------------------------------------------

describe('V3: a malformed terminal entry is STATE_CORRUPT', () => {
  it('the run’s terminal entry does not parse → STATE_CORRUPT naming the run', async () => {
    const be = memBackend();
    const now = '2026-10-06T00:00:00.000Z';
    await writeTerminal(
      be,
      's1',
      'run-1',
      { kind: 'success', answer: 'older' },
      60_000,
      now,
    );
    await be.put('s1', {
      content: 'garbage',
      metadata: { artifactType: 'controller-terminal', runId: 'run-1' },
    });
    await assert.rejects(
      readTerminal(be, 's1', 'run-1', now),
      corrupt(STATE_CORRUPT, /run-1/, /s1/),
    );
  });
});

// ---------------------------------------------------------------------------
// V4 — a claim without writeOrdinal
// ---------------------------------------------------------------------------

describe('V4: a step-start claim without writeOrdinal is STATE_CORRUPT', () => {
  it('names the claim', async () => {
    const rag = {
      list: async () => [
        {
          content: '',
          metadata: {
            artifactType: STEP_START_ARTIFACT,
            runId: 'r',
            slotId: 'sl',
            stepId: 'step-7',
            seq: 0,
            attempt: 0,
            decisionId: 'd',
          },
        },
      ],
    };
    await assert.rejects(
      readClaims(rag as never, 'r'),
      corrupt(STATE_CORRUPT, /step-7/, /sl/, /writeOrdinal/),
    );
  });
});

// ---------------------------------------------------------------------------
// V5 — session metadata
// ---------------------------------------------------------------------------

function chatBody() {
  return {
    model: 'stub',
    messages: [{ role: 'user', content: 'hi' }],
  };
}

describe('V5: session metadata', () => {
  it('recordSessionStart throwing → the chat request answers 500 jsonError', async () => {
    class StartFails extends InMemorySessionMetaStore {
      override async create(): Promise<void> {
        throw new Error('meta store down');
      }
    }
    const server = new SmartServer(
      { port: 0, llm: { model: 'stub' }, skipModelValidation: true },
      makeLlmDeps(),
    );
    (server as unknown as { _sessionMetaStore: unknown })._sessionMetaStore =
      new StartFails();
    const handle = await server.start();
    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        chatBody(),
      );
      assert.equal(res.status, 500);
      const body = res.body as { error?: { message?: string; type?: string } };
      assert.match(body.error?.message ?? '', /meta store down/);
      assert.equal(body.error?.type, 'server_error');
    } finally {
      await handle.close();
    }
  });

  it('recordSessionEnd throwing → the response is unaffected and session_meta_end_failed is logged', async () => {
    class EndFails extends InMemorySessionMetaStore {
      override async setStatus(): Promise<void> {
        throw new Error('meta end down');
      }
    }
    const events: Record<string, unknown>[] = [];
    const server = new SmartServer(
      {
        port: 0,
        llm: { model: 'stub' },
        skipModelValidation: true,
        log: (e) => {
          events.push(e);
        },
      },
      makeLlmDeps(),
    );
    (server as unknown as { _sessionMetaStore: unknown })._sessionMetaStore =
      new EndFails();
    const handle = await server.start();
    try {
      const res = await httpRequest(
        handle.port,
        'POST',
        '/v1/chat/completions',
        chatBody(),
      );
      assert.equal(res.status, 200);
      const failed = events.filter(
        (e) => e.event === 'session_meta_end_failed',
      );
      assert.equal(failed.length, 1, JSON.stringify(events));
      assert.match(String(failed[0].error), /meta end down/);
      assert.equal(typeof failed[0].sessionId, 'string');
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// V7 — the eager tool catalog load at start
// ---------------------------------------------------------------------------

const down: IMcpClient = {
  async listTools() {
    return {
      ok: false as const,
      error: new McpError('Not connected', 'MCP_NOT_CONNECTED'),
    };
  },
  async callTool() {
    return {
      ok: false as const,
      error: new McpError('Not connected', 'MCP_NOT_CONNECTED'),
    };
  },
} as unknown as IMcpClient;

describe('V7: the eager tool catalog load', () => {
  it('the handle’s eager load fails → its construction rejects with the McpError', async () => {
    await assert.rejects(
      makeToolsRagHandle([down], undefined, undefined),
      (e: unknown) => e instanceof McpError && e.code === 'MCP_NOT_CONNECTED',
    );
  });

  it('fails at start → start() rejects with the McpError', async () => {
    const server = new SmartServer(
      {
        port: 0,
        llm: { model: 'stub' },
        skipModelValidation: true,
        mcpClients: [down],
      },
      makeLlmDeps(),
    );
    await assert.rejects(
      server.start(),
      (e: unknown) => e instanceof McpError && e.code === 'MCP_NOT_CONNECTED',
    );
  });
});

// ---------------------------------------------------------------------------
// V9 — a stepper role with no resolvable LLM config
// ---------------------------------------------------------------------------

describe('V9: a stepper role with no LLM config', () => {
  it('→ ConfigValidationError naming the role (never a stub model)', async () => {
    const built: string[] = [];
    const spec: StepperCompositionSpec = {
      planner: 'none',
      granularity: 'shallow',
      executor: 'cyclic-react',
      finalizer: 'llm',
      reviewerAtDepths: { has: () => false },
      maxParallelSteps: 4,
      maxDepth: 5,
      tokenBudget: 100000,
      formalizeTask: false,
    };
    await assert.rejects(
      buildFromComposition(spec, {
        makeLlm: async (cfg) => {
          built.push(cfg.model ?? '');
          throw new Error('not expected');
        },
        callMcp: async () => 'result',
        mintStepperId: () => 's',
        registry: new Map(),
      }),
      (e: unknown) => {
        assert.ok(e instanceof ConfigValidationError, `got ${String(e)}`);
        assert.match(e.message, /role '\w[\w-]*'/);
        return true;
      },
    );
    assert.deepEqual(built, [], 'no LLM is built for a role with no config');
  });
});
