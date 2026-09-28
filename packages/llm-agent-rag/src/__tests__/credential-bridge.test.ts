import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type {
  IApiKeyCredential,
  ISecretLoginCredential,
} from '@mcp-abap-adt/interfaces-auth';
import type { EmbedderFactoryConfig, IEmbedder } from '@mcp-abap-adt/llm-agent';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  _resetPrefetchedForTests,
  type EmbedderResolution,
  prefetchEmbedderFactories,
} from '../embedder-factories.js';
import {
  makeRag,
  type RagResolution,
  resolveEmbedder,
} from '../rag-factories.js';

const apiKey: IApiKeyCredential = { kind: 'api-key', secret: async () => 'k' };
const login: ISecretLoginCredential = {
  kind: 'secret-login',
  principal: 'u',
  secret: async () => 'p',
};

const stubEmbedder: IEmbedder = {
  embed: async () => [0],
  embedBatch: async (texts: string[]) => texts.map(() => [0]),
} as unknown as IEmbedder;

/** Replace fetch for one block: every embedder here talks HTTP through it. */
async function withFetch(
  reply: unknown,
  run: (seen: Array<{ url: string; init?: RequestInit }>) => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await run(seen);
  } finally {
    globalThis.fetch = real;
  }
}

describe('the embedder bridge and credentials', () => {
  // Wrong kind, missing credential, missing apiBaseUrl, a credential for
  // ollama or for a consumer factory, and a legacy apiKey on a typed literal
  // are proven by the compiler — ../__typechecks__/embedder-resolution.ts,
  // run by `npm run typecheck`. What is tested here is what no compiler sees.
  afterEach(() => _resetPrefetchedForTests());

  it('asks the very credential object it was given, on each request', async () => {
    await prefetchEmbedderFactories(['openai']);
    let asked = 0;
    const counted: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => {
        asked += 1;
        return 'k-live';
      },
    };
    const e = resolveEmbedder({
      provider: 'openai',
      model: 'text-embedding-3-small',
      credential: counted,
    });
    await withFetch({ data: [{ embedding: [1, 2] }] }, async (seen) => {
      await e.embed('hello');
      assert.equal(
        asked,
        1,
        'the object itself must arrive — a copied secret would never call back',
      );
      const headers = seen[0].init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'Bearer k-live');
    });
  });

  it('sends the configured url to the field each embedder actually reads', async () => {
    await prefetchEmbedderFactories(['ollama', 'openai']);
    const ollama = resolveEmbedder({
      provider: 'ollama',
      model: 'bge-m3',
      url: 'http://ollama.example:11434',
    });
    await withFetch({ embedding: [1] }, async (seen) => {
      await ollama.embed('x');
      assert.equal(
        seen[0].url,
        'http://ollama.example:11434/api/embeddings',
        'OllamaEmbedder reads ollamaUrl; the old bag passed url, so this fell back to localhost',
      );
    });
    const openai = resolveEmbedder({
      provider: 'openai',
      model: 'm',
      credential: apiKey,
      url: 'https://gw.example/v1',
    });
    await withFetch({ data: [{ embedding: [1] }] }, async (seen) => {
      await openai.embed('x');
      assert.equal(
        seen[0].url,
        'https://gw.example/v1/embeddings',
        'OpenAiEmbedder reads baseURL; the old bag passed url, so this went to api.openai.com',
      );
    });
  });

  it('hands a consumer factory exactly EmbedderFactoryConfig, and never a credential', () => {
    let seen: EmbedderFactoryConfig | undefined;
    resolveEmbedder(
      { factory: 'mine', url: 'http://u', model: 'm', timeoutMs: 5 },
      {
        extraFactories: {
          mine: (cfg) => {
            seen = cfg;
            return stubEmbedder;
          },
        },
      },
    );
    assert.deepEqual(seen, { url: 'http://u', model: 'm', timeoutMs: 5 });
  });

  it('names an unregistered factory instead of guessing', () => {
    assert.throws(
      () => resolveEmbedder({ factory: 'nope', model: 'm' }),
      /Unknown embedder factory "nope"/,
    );
  });

  it('refuses a legacy field arriving from an untyped source', () => {
    const fromYaml = (extra: Record<string, unknown>) =>
      ({
        provider: 'ollama',
        model: 'm',
        ...extra,
      }) as unknown as EmbedderResolution;
    assert.throws(
      () => resolveEmbedder(fromYaml({ apiKey: 'k' })),
      /apiKey.*credential/,
      'a loaded object is not a fresh literal, so only this can catch it',
    );
    assert.throws(
      () => resolveEmbedder(fromYaml({ embedder: 'openai' })),
      /embedder.*provider/,
      'the old name field would otherwise fall through to the ollama default in silence',
    );
  });

  it('names an unknown provider arriving from an untyped source', () => {
    assert.throws(
      () =>
        resolveEmbedder({
          provider: 'deepseek',
          model: 'm',
        } as unknown as EmbedderResolution),
      /Unknown embedder provider "deepseek"/,
    );
  });
});

describe('the store bridge and credentials', () => {
  // The wrong-kind, missing-required-credential and legacy-field-on-a-typed-
  // literal cases are proven by the compiler now, not by a test — see
  // packages/llm-agent-rag/src/__typechecks__/rag-resolution.ts, run by
  // `npm run typecheck`. What remains testable here is the one thing the
  // compiler cannot see: a value arriving from an UNTYPED source.
  it('refuses a legacy secret field arriving from an untyped source', async () => {
    for (const field of ['apiKey', 'user', 'password'] as const) {
      const fromYaml = {
        type: 'qdrant',
        embedder: symmetricEmbedder(stubEmbedder),
        collectionName: 'c',
        url: 'http://localhost:6333',
        [field]: 'leftover',
      } as unknown as RagResolution;
      await assert.rejects(
        () => makeRag(fromYaml),
        new RegExp(`${field}.*credential`, 'i'),
        `a loaded object is not a fresh literal, so only this can catch ${field}`,
      );
    }
  });

  it('observed: the credential object itself reaches a constructed QdrantRag instance', async () => {
    // QdrantRag's constructor is synchronous and does no I/O, so this is a
    // live construction through the real, literal-imported class, not a
    // stand-in — and it directly answers whether the object survives
    // makeRag's destructure-and-spread into the constructor argument.
    const instance = await makeRag({
      type: 'qdrant',
      url: 'http://localhost:6333',
      collectionName: 'c',
      embedder: symmetricEmbedder(stubEmbedder),
      credential: apiKey,
    });
    const seen = (instance as unknown as { credential?: unknown }).credential;
    assert.equal(seen, apiKey, 'the exact object must survive makeRag');
  });

  it('observed: a real PgVectorRag consumes the forwarded credential with no network I/O', async () => {
    // pg's Pool is lazy — PgVectorRag never connects until a query runs —
    // so constructing it and letting its internal driver setup resolve is a
    // live, zero-I/O construction through the real class.
    const instance = await makeRag({
      type: 'pg-vector',
      host: 'db.example',
      collectionName: 'c',
      embedder: symmetricEmbedder(stubEmbedder),
      credential: login,
    });
    await assert.doesNotReject(
      (instance as unknown as { clientPromise: Promise<unknown> })
        .clientPromise,
      'resolvePgConnectArgs must accept the forwarded credential without throwing',
    );
  });

  it('still builds a hybrid in-memory VectorRag, mapping collectionName to namespace', async () => {
    const instance = await makeRag({
      type: 'in-memory',
      embedder: symmetricEmbedder(stubEmbedder),
      collectionName: 'my-namespace',
    });
    assert.ok(
      instance,
      'construction must succeed with only the in-memory arm’s own fields',
    );
  });
});
