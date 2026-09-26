import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import {
  type IEmbedder,
  InMemoryRag,
  type IRag,
  type ISkillPluginHost,
  staticApiKey,
  staticLogin,
} from '@mcp-abap-adt/llm-agent';
import type {
  BuildSkillHostDeps,
  MakeRagInput,
  SkillPluginsConfig,
  SmartServerEmbedderConfig,
} from '@mcp-abap-adt/llm-agent-server-libs';
import { createBuildSkillHost } from '../build-skill-host.js';
import {
  type CredentialEntry,
  DEFAULT_STORE_REF,
  memoizeCredentials,
} from '../credential-for.js';
import { createLookup } from '../lookup.js';
import { createMakeRag } from '../make-rag.js';
import { createResolveEmbedder } from '../resolve-embedder.js';

const embedder = {
  embed: async () => ({ vector: [0] }),
} as unknown as IEmbedder;
const bearer: IBearerCredential = { kind: 'bearer', token: async () => 't' };
const lookupOver = (entries: Record<string, CredentialEntry>) =>
  createLookup(memoizeCredentials((r) => entries[r]));

describe('resolveEmbedder seam: SmartServerEmbedderConfig → EmbedderResolution', () => {
  const recorder = () => {
    const seen: Record<string, unknown>[] = [];
    const impl = ((cfg: Record<string, unknown>) => {
      seen.push(cfg);
      return embedder;
    }) as unknown as Parameters<typeof createResolveEmbedder>[1];
    return { seen, impl };
  };

  it('openai gets an api-key credential and its named fields; the ref does not travel on', () => {
    const cred = staticApiKey('k');
    const { seen, impl } = recorder();
    const resolve = createResolveEmbedder(
      lookupOver({ OPENAI: { credential: cred } }),
      impl,
    );
    const section: SmartServerEmbedderConfig = {
      provider: 'openai',
      model: 'e',
      url: 'https://gw',
      maxBatchSize: 8,
      credentialRef: 'OPENAI',
    };
    resolve(section);
    assert.deepEqual(seen[0], {
      provider: 'openai',
      model: 'e',
      url: 'https://gw',
      maxBatchSize: 8,
      credential: cred,
    });
  });

  it('sap-ai-core and sap-aicore need a bearer AND an apiBaseUrl from the same entry', () => {
    const { seen, impl } = recorder();
    const resolve = createResolveEmbedder(
      lookupOver({
        A: { credential: bearer, apiBaseUrl: 'https://a' },
        B: { credential: bearer },
      }),
      impl,
    );
    resolve({
      provider: 'sap-ai-core',
      model: 'e',
      scenario: 'foundation-models',
      credentialRef: 'A',
    });
    resolve({
      provider: 'sap-aicore',
      model: 'e',
      resourceGroup: 'rg',
      credentialRef: 'A',
    });
    assert.equal(seen[0]?.credential, bearer);
    assert.equal(seen[0]?.apiBaseUrl, 'https://a');
    assert.equal(seen[0]?.scenario, 'foundation-models');
    assert.equal(seen[1]?.provider, 'sap-aicore');
    assert.equal(seen[1]?.resourceGroup, 'rg');
    assert.throws(
      () =>
        resolve({ provider: 'sap-ai-core', model: 'e', credentialRef: 'B' }),
      /'B' must carry an apiBaseUrl/,
    );
  });

  it('ollama sends nothing: a named ref is refused, an omitted one reads no entry', () => {
    const asked: string[] = [];
    const { seen, impl } = recorder();
    const resolve = createResolveEmbedder(
      createLookup(
        memoizeCredentials((r) => {
          asked.push(r);
          return r === 'K' ? { credential: staticApiKey('k') } : undefined;
        }),
      ),
      impl,
    );
    assert.throws(
      () => resolve({ provider: 'ollama', model: 'e', credentialRef: 'K' }),
      /ollama takes no credential, so credentialRef 'K' cannot apply/,
    );
    asked.length = 0;
    resolve({ provider: 'ollama', model: 'e', url: 'http://o' });
    assert.deepEqual(asked, [], 'RAG_EMBEDDER was not even read');
    assert.deepEqual(seen[0], {
      provider: 'ollama',
      model: 'e',
      url: 'http://o',
    });
  });

  it('a consumer factory reaches the library factory arm, and takes no credential', () => {
    const { seen, impl } = recorder();
    const resolve = createResolveEmbedder(
      lookupOver({ K: { credential: staticApiKey('k') } }),
      impl,
    );
    resolve({ factory: 'mine', model: 'm', url: 'http://u' });
    assert.deepEqual(seen[0], { factory: 'mine', model: 'm', url: 'http://u' });
    assert.equal(
      'provider' in (seen[0] ?? {}),
      false,
      'never the built-in provider path',
    );
    assert.throws(
      () =>
        resolve({
          factory: 'mine',
          model: 'm',
          credentialRef: 'K',
        } as unknown as SmartServerEmbedderConfig),
      /embedder factory 'mine' takes no credential/,
    );
  });

  it('a built-in without a model is refused, naming the provider — the library arm requires one', () => {
    const { impl } = recorder();
    const resolve = createResolveEmbedder(
      lookupOver({ OPENAI: { credential: staticApiKey('k') } }),
      impl,
    );
    assert.throws(
      () => resolve({ provider: 'openai', credentialRef: 'OPENAI' }),
      /rag\.embedder\.model is required for provider 'openai'/,
    );
  });
});

describe('makeRag seam', () => {
  const recorder = () => {
    const seen: Record<string, unknown>[] = [];
    const impl = (async (cfg: Record<string, unknown>) => {
      seen.push(cfg);
      return {} as IRag;
    }) as unknown as Parameters<typeof createMakeRag>[1];
    return { seen, impl };
  };

  it('in-memory without an embedder is the keyword-only store, built directly', async () => {
    const { seen, impl } = recorder();
    const rag = await createMakeRag(
      lookupOver({}),
      impl,
    )({
      store: { type: 'in-memory', dedupThreshold: 0.8 },
    } as MakeRagInput);
    assert.ok(rag instanceof InMemoryRag);
    assert.equal(seen.length, 0);
  });

  it('in-memory takes no credential: a named ref is refused', async () => {
    const { impl } = recorder();
    await assert.rejects(
      () =>
        createMakeRag(
          lookupOver({ K: { credential: staticApiKey('k') } }),
          impl,
        )({
          store: { type: 'in-memory', credentialRef: 'K' },
          embedder,
        } as MakeRagInput),
      /in-memory takes no credential/,
    );
  });

  it('qdrant: named ref → its api key; omitted with no default entry → anonymous; ref never forwarded', async () => {
    const cred = staticApiKey('q');
    const { seen, impl } = recorder();
    const make = createMakeRag(
      lookupOver({ QDRANT: { credential: cred } }),
      impl,
    );
    await make({
      store: {
        type: 'qdrant',
        url: 'http://q',
        collectionName: 'c',
        credentialRef: 'QDRANT',
      },
      embedder,
    } as MakeRagInput);
    await make({
      store: { type: 'qdrant', url: 'http://q', collectionName: 'c' },
      embedder,
    } as MakeRagInput);
    assert.equal(seen[0]?.credential, cred);
    assert.equal(seen[0]?.embedder, embedder);
    assert.equal('credential' in (seen[1] ?? {}), false);
    for (const cfg of seen) assert.equal('credentialRef' in cfg, false);
  });

  it('hana requires a secret-login; pg with a misspelled ref is refused by name', async () => {
    const { seen, impl } = recorder();
    const make = createMakeRag(
      lookupOver({
        PG: { credential: staticLogin('u', 'p') },
        KEY: { credential: staticApiKey('k') },
      }),
      impl,
    );
    await assert.rejects(
      () =>
        make({
          store: {
            type: 'hana-vector',
            collectionName: 'c',
            credentialRef: 'KEY',
          },
          embedder,
        } as MakeRagInput),
      /secret-login credential for hana-vector, got api-key/,
    );
    await assert.rejects(
      () =>
        make({
          store: {
            type: 'pg-vector',
            collectionName: 'c',
            credentialRef: 'PGG',
          },
          embedder,
        } as MakeRagInput),
      /'PGG' for pg-vector has no entry/,
    );
    await make({
      store: { type: 'hana-vector', collectionName: 'c', credentialRef: 'PG' },
      embedder,
    } as MakeRagInput);
    assert.equal(
      (seen[0]?.credential as { kind?: string } | undefined)?.kind,
      'secret-login',
    );
  });
});

describe('buildSkillHost seam: the skill store account (§8 item 4)', () => {
  const recorder = () => {
    const seen: BuildSkillHostDeps[] = [];
    const impl = (async (
      _cfg: SkillPluginsConfig,
      deps: BuildSkillHostDeps,
    ) => {
      seen.push(deps);
      return {} as ISkillPluginHost;
    }) as Parameters<typeof createBuildSkillHost>[1];
    return { seen, impl };
  };
  const hostDeps = {
    resolveEmbedder: () => embedder,
  } as unknown as BuildSkillHostDeps;
  const skills = (store: Record<string, unknown>) =>
    ({ store }) as unknown as SkillPluginsConfig;

  it('a named qdrant ref reaches the factory as storeCredential, the other deps untouched', async () => {
    const cred = staticApiKey('q');
    const { seen, impl } = recorder();
    const build = createBuildSkillHost(
      lookupOver({ SKILLS_QDRANT: { credential: cred } }),
      impl,
    );
    await build(
      skills({
        type: 'qdrant',
        url: 'http://q',
        credentialRef: 'SKILLS_QDRANT',
      }),
      hostDeps,
    );
    assert.equal(seen[0]?.storeCredential, cred);
    assert.equal(seen[0]?.resolveEmbedder, hostDeps.resolveEmbedder);
  });

  it('an omitted ref reads the store default; with no entry the store is anonymous', async () => {
    const cred = staticApiKey('default');
    const withDefault = recorder();
    await createBuildSkillHost(
      lookupOver({ [DEFAULT_STORE_REF]: { credential: cred } }),
      withDefault.impl,
    )(skills({ type: 'qdrant', url: 'http://q' }), hostDeps);
    assert.equal(withDefault.seen[0]?.storeCredential, cred);
    const anonymous = recorder();
    await createBuildSkillHost(lookupOver({}), anonymous.impl)(
      skills({ type: 'qdrant', url: 'http://q' }),
      hostDeps,
    );
    assert.equal('storeCredential' in (anonymous.seen[0] ?? {}), false);
  });

  it('a misspelled or wrong-kind ref is refused by name — never sent anonymously', async () => {
    const { seen, impl } = recorder();
    const build = createBuildSkillHost(
      lookupOver({ LOGIN: { credential: staticLogin('u', 'p') } }),
      impl,
    );
    await assert.rejects(
      () =>
        build(
          skills({ type: 'qdrant', url: 'http://q', credentialRef: 'SKILS' }),
          hostDeps,
        ),
      /credentialRef 'SKILS' for skill store \(qdrant\) has no entry/,
    );
    await assert.rejects(
      () =>
        build(
          skills({ type: 'qdrant', url: 'http://q', credentialRef: 'LOGIN' }),
          hostDeps,
        ),
      /must hold a api-key credential for skill store \(qdrant\), got secret-login/,
    );
    assert.equal(seen.length, 0);
  });

  it('an in-memory skill store reads no credential at all', async () => {
    const asked: string[] = [];
    const { seen, impl } = recorder();
    const build = createBuildSkillHost(
      createLookup(
        memoizeCredentials((r) => {
          asked.push(r);
          return undefined;
        }),
      ),
      impl,
    );
    await build(skills({ type: 'in-memory' }), hostDeps);
    assert.deepEqual(asked, []);
    assert.equal(seen[0], hostDeps);
  });
});
