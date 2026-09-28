import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IEmbedder,
  InMemoryRag,
  type IRag,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { resolveSmartServerConfig } from '../config.js';
import {
  isInMemoryInput,
  type MakeRagInput,
  type SmartServerEmbedderConfig,
  toMakeRagInput,
} from '../rag-config.js';
import { SmartServer, type SmartServerConfig } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

const llm = { provider: 'ollama', model: 'qwen2.5' };
const stubEmbedder = {
  embed: async () => ({ vector: [1, 0] }),
} as unknown as IEmbedder;

describe('rag: splits into store and embedder, each with its own account', () => {
  it('carries two credentialRefs, one per target', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        llm,
        rag: {
          store: {
            type: 'qdrant',
            url: 'http://localhost:6333',
            collectionName: 'docs',
            credentialRef: 'QDRANT',
          },
          embedder: {
            provider: 'openai',
            model: 'text-embedding-3-small',
            credentialRef: 'OPENAI',
          },
        },
      },
      {},
    );
    assert.deepEqual(cfg.rag?.store, {
      type: 'qdrant',
      url: 'http://localhost:6333',
      collectionName: 'docs',
      credentialRef: 'QDRANT',
    });
    assert.equal(cfg.rag?.embedder?.provider, 'openai');
    assert.equal(cfg.rag?.embedder?.credentialRef, 'OPENAI');
  });

  it('defaults the search knobs on the in-memory store, where they are read', () => {
    const cfg = resolveSmartServerConfig(
      {},
      { llm, rag: { store: { type: 'in-memory' } } },
      {},
    );
    assert.deepEqual(cfg.rag, {
      store: {
        type: 'in-memory',
        dedupThreshold: 0.92,
        vectorWeight: 0.7,
        keywordWeight: 0.3,
      },
    });
  });

  it('gives a qdrant store the collection name main defaulted', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        llm,
        rag: {
          store: { type: 'qdrant', url: 'http://q' },
          embedder: { provider: 'ollama', model: 'bge-m3' },
        },
      },
      {},
    );
    const store = cfg.rag?.store as { collectionName?: string } | undefined;
    assert.equal(store?.collectionName, 'llm-agent');
  });

  it('projects a pg-vector address from YAML, coercing a ${VAR}-substituted port', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        llm,
        rag: {
          store: {
            type: 'pg-vector',
            collectionName: 'docs',
            host: 'db',
            port: '5432',
            database: 'rag',
            schema: 'public',
            dimension: '1024',
            autoCreateSchema: false,
            credentialRef: 'RAG_PG',
          },
          embedder: { provider: 'ollama', model: 'bge-m3' },
        },
      },
      {},
    );
    assert.deepEqual(cfg.rag?.store, {
      type: 'pg-vector',
      collectionName: 'docs',
      host: 'db',
      port: 5432,
      database: 'rag',
      schema: 'public',
      dimension: 1024,
      autoCreateSchema: false,
      credentialRef: 'RAG_PG',
    });
  });

  it('refuses the flat shape, pointing at rag.store and rag.embedder', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm,
            rag: {
              type: 'qdrant',
              url: 'http://q',
              embedder: 'openai',
              model: 'm',
            },
          },
          {},
        ),
      /flat 'rag:'[\s\S]*rag\.store[\s\S]*rag\.embedder/,
    );
  });

  it('refuses a secret inside either section, naming its credentialRef', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm,
            rag: {
              store: {
                type: 'pg-vector',
                collectionName: 'c',
                password: 'pw',
              },
              embedder: { provider: 'ollama', model: 'bge-m3' },
            },
          },
          {},
        ),
      /rag\.store\.password[\s\S]*rag\.store\.credentialRef/,
    );
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm,
            rag: {
              store: { type: 'in-memory' },
              embedder: { provider: 'openai', model: 'm', apiKey: 'sk' },
            },
          },
          {},
        ),
      /rag\.embedder\.apiKey[\s\S]*rag\.embedder\.credentialRef/,
    );
  });

  it('refuses search knobs on a store that never read them', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm,
            rag: {
              store: {
                type: 'qdrant',
                url: 'http://q',
                vectorWeight: 0.5,
              },
              embedder: { provider: 'ollama', model: 'bge-m3' },
            },
          },
          {},
        ),
      /rag\.store\.vectorWeight: read only by the in-memory store/,
    );
  });

  it('accepts a keyword-only store with no embedder section', () => {
    assert.doesNotThrow(() =>
      resolveSmartServerConfig(
        {},
        { llm, rag: { store: { type: 'in-memory' } } },
        {},
      ),
    );
  });

  it('defaults an embedder section with no provider to ollama', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        llm,
        rag: { store: { type: 'in-memory' }, embedder: { model: 'bge-m3' } },
      },
      {},
    );
    assert.deepEqual(cfg.rag?.embedder, {
      provider: 'ollama',
      model: 'bge-m3',
    });
  });

  it('names a consumer-registered embedder with factory, carrying no account', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        llm,
        rag: {
          store: { type: 'in-memory' },
          embedder: {
            factory: 'gemini',
            model: 'text-embedding-004',
            maxBatchSize: 50,
          },
        },
      },
      {},
    );
    assert.deepEqual(cfg.rag?.embedder, {
      factory: 'gemini',
      model: 'text-embedding-004',
      maxBatchSize: 50,
    });
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm,
            rag: {
              store: { type: 'in-memory' },
              embedder: { factory: 'gemini', credentialRef: 'GEMINI' },
            },
          },
          {},
        ),
      /rag\.embedder\.credentialRef[\s\S]*factory/,
      'a consumer factory closes over its own credential; a ref here would authorize nothing',
    );
  });

  it('refuses an unknown provider, pointing at factory', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm,
            rag: {
              store: { type: 'in-memory' },
              embedder: { provider: 'gemini', model: 'm' },
            },
          },
          {},
        ),
      /rag\.embedder\.provider[\s\S]*rag\.embedder\.factory/,
    );
  });

  it('refuses apiBaseUrl in YAML: it comes from the credential entry', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm,
            rag: {
              store: { type: 'in-memory' },
              embedder: {
                provider: 'sap-ai-core',
                model: 'text-embedding-3-small',
                apiBaseUrl: 'https://api.ai.example',
              },
            },
          },
          {},
        ),
      /rag\.embedder\.apiBaseUrl[\s\S]*credential entry[\s\S]*_SERVICE_KEY/,
      'two sources for one value is what the credential entry removes',
    );
  });
});

describe('BuildAgentDeps.makeRag is the only way a store is built', () => {
  it('pairs a vector store with an embedder, and refuses one without', () => {
    const qdrant = {
      type: 'qdrant' as const,
      url: 'http://q',
      collectionName: 'c',
    };
    assert.throws(
      () => toMakeRagInput(qdrant, undefined, 'rag'),
      /rag\.store\.type 'qdrant' needs an embedder[\s\S]*rag\.embedder/,
    );
    const paired = toMakeRagInput(
      qdrant,
      symmetricEmbedder(stubEmbedder),
      'rag',
    );
    assert.equal(isInMemoryInput(paired), false);
    const keywordOnly = toMakeRagInput({ type: 'in-memory' }, undefined, 'rag');
    assert.equal(isInMemoryInput(keywordOnly), true);
    assert.equal(keywordOnly.embedder, undefined);
  });

  it('refuses a SmartServer without makeRag, naming it', () => {
    assert.throws(
      () =>
        new SmartServer(
          {} as SmartServerConfig,
          {
            makeLlm: constructionSeams.makeLlm,
            resolveEmbedder: constructionSeams.resolveEmbedder,
          } as never,
        ),
      /BuildAgentDeps\.makeRag/,
    );
  });

  it('refuses a programmatic config still in the flat shape', () => {
    assert.throws(
      () =>
        new SmartServer(
          { rag: { type: 'in-memory' } } as unknown as SmartServerConfig,
          constructionSeams,
        ),
      /rag\.store is required/,
    );
  });

  it('builds the tools and the history store through the seam, embedder resolved first', async () => {
    const embedderAsked: SmartServerEmbedderConfig[] = [];
    const inputs: MakeRagInput[] = [];
    const server = new SmartServer(
      {
        port: 0,
        skipModelValidation: true,
        llm: { main: { provider: 'ollama', model: 'qwen2.5' } },
        rag: {
          store: { type: 'in-memory', collectionName: 'docs' },
          embedder: {
            provider: 'ollama',
            model: 'bge-m3',
            credentialRef: 'LOCAL_OLLAMA',
          },
        },
      },
      {
        ...constructionSeams,
        resolveEmbedder: (ec) => {
          embedderAsked.push(ec);
          return stubEmbedder;
        },
        makeRag: async (input): Promise<IRag> => {
          inputs.push(input);
          return new InMemoryRag();
        },
      },
    );
    const handle = await server.start();
    try {
      assert.equal(embedderAsked.length, 1);
      assert.equal(embedderAsked[0]?.credentialRef, 'LOCAL_OLLAMA');
      assert.equal(inputs.length, 2, 'tools store and history store');
      for (const input of inputs) {
        assert.equal(input.store.type, 'in-memory');
        assert.equal(input.store.collectionName, 'docs');
        assert.ok(
          input.embedder,
          'the resolved embedder travels with the store',
        );
      }
    } finally {
      await handle.close();
    }
  });
});
