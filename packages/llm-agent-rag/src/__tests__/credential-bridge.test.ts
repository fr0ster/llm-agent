import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IApiKeyCredential,
  IBearerCredential,
} from '@mcp-abap-adt/interfaces-auth';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import type { EmbedderFactoryOpts } from '../embedder-factories.js';
import { resolveEmbedder } from '../rag-factories.js';

const apiKey: IApiKeyCredential = { kind: 'api-key', secret: async () => 'k' };
const bearer: IBearerCredential = { kind: 'bearer', token: async () => 't' };

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
