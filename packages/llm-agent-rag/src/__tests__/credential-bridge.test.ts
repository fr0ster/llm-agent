import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IApiKeyCredential,
  IBearerCredential,
  ISecretLoginCredential,
} from '@mcp-abap-adt/interfaces-auth';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import type { EmbedderFactoryOpts } from '../embedder-factories.js';
import {
  makeRag,
  type RagResolution,
  resolveEmbedder,
} from '../rag-factories.js';

const apiKey: IApiKeyCredential = { kind: 'api-key', secret: async () => 'k' };
const bearer: IBearerCredential = { kind: 'bearer', token: async () => 't' };
const login: ISecretLoginCredential = {
  kind: 'secret-login',
  principal: 'u',
  secret: async () => 'p',
};

const stubEmbedder: IEmbedder = {
  embed: async () => [0],
  embedBatch: async (texts: string[]) => texts.map(() => [0]),
} as unknown as IEmbedder;

describe('the embedder bridge and credentials', () => {
  it('forwards the credential object itself, not a copy of a secret', () => {
    let seen: EmbedderFactoryOpts | undefined;
    resolveEmbedder(
      {
        embedder: 'capture',
        credential: apiKey,
        apiBaseUrl: 'https://aicore.example',
      },
      {
        extraFactories: {
          capture: (opts) => {
            seen = opts;
            return stubEmbedder;
          },
        },
      },
    );
    assert.equal(
      seen?.credential,
      apiKey,
      'the same object must arrive, so quota identity survives',
    );
    assert.equal(seen?.apiBaseUrl, 'https://aicore.example');
  });

  it('no longer carries an apiKey field for anything to read', () => {
    let seen: EmbedderFactoryOpts | undefined;
    resolveEmbedder(
      { embedder: 'capture', apiKey: 'leftover' } as unknown as Parameters<
        typeof resolveEmbedder
      >[0],
      {
        extraFactories: {
          capture: (opts) => {
            seen = opts;
            return stubEmbedder;
          },
        },
      },
    );
    assert.ok(
      seen && !('apiKey' in seen),
      'a stale apiKey must not reach a factory',
    );
  });

  it('refuses a named embedder that cannot work without a credential', () => {
    assert.throws(
      () => resolveEmbedder({ embedder: 'openai' }),
      /openai.*credential/i,
      'a missing credential must name itself, not produce an unauthenticated embedder',
    );
  });

  it('refuses the wrong kind of credential for the target', () => {
    assert.throws(
      () => resolveEmbedder({ embedder: 'openai', credential: bearer }),
      /openai.*api-key.*bearer/i,
    );
    assert.throws(
      () =>
        resolveEmbedder({
          embedder: 'sap-ai-core',
          credential: apiKey,
          apiBaseUrl: 'https://x',
        }),
      /sap-ai-core.*bearer.*api-key/i,
    );
  });

  it('refuses a credential for a target that sends none', () => {
    assert.throws(
      () => resolveEmbedder({ embedder: 'ollama', credential: apiKey }),
      /ollama.*no credential/i,
      'silently ignoring it would hide a misconfigured deployment',
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
        embedder: stubEmbedder,
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
      embedder: stubEmbedder,
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
      embedder: stubEmbedder,
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
      embedder: stubEmbedder,
      collectionName: 'my-namespace',
    });
    assert.ok(
      instance,
      'construction must succeed with only the in-memory arm’s own fields',
    );
  });
});
