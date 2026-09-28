/**
 * The serializable RAG configuration: a STORE and an EMBEDDER, two independently
 * authenticated targets, each with its own `credentialRef` (spec §4.6.4). The flat
 * shape this replaces held both at once, so `url` meant Qdrant's address or Ollama's
 * depending on its neighbours and no single reference could say which account it
 * named.
 *
 * `credentialRef` is a NAME the composition root resolves — never a value.
 */
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';

/**
 * The in-memory store. The search knobs live here because this is the only store
 * that ever read them (VectorRag with an embedder, InMemoryRag without); Qdrant,
 * pgvector and HANA never did. `collectionName` becomes VectorRag's namespace.
 * `credentialRef` authenticates nothing here: it is declared so a composition root
 * can destructure it off any arm and refuse it on this one (§4.6.4's reference
 * `makeRag` does exactly that, and does not compile without the member).
 */
export interface InMemoryStoreConfig {
  type: 'in-memory';
  collectionName?: string;
  dedupThreshold?: number;
  vectorWeight?: number;
  keywordWeight?: number;
  credentialRef?: string;
}

export interface QdrantStoreConfig {
  type: 'qdrant';
  url: string;
  collectionName: string;
  /** Per-request timeout in ms; unset, a request is bounded only by the caller's signal. */
  timeoutMs?: number;
  credentialRef?: string;
}

export interface PgVectorStoreConfig {
  type: 'pg-vector';
  collectionName: string;
  /** The address only — a string carrying user:password is refused at construction. */
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
  poolMax?: number;
  connectTimeout?: number;
  dimension?: number;
  autoCreateSchema?: boolean;
  credentialRef?: string;
}

export interface HanaVectorStoreConfig {
  type: 'hana-vector';
  collectionName: string;
  /** The address only — a string carrying user:password is refused at construction. */
  connectionString?: string;
  host?: string;
  port?: number;
  schema?: string;
  poolMax?: number;
  connectTimeout?: number;
  dimension?: number;
  autoCreateSchema?: boolean;
  /** HANA has no anonymous login, so the root must resolve one (its default or this). */
  credentialRef?: string;
}

export type SmartServerRagStoreConfig =
  | InMemoryStoreConfig
  | QdrantStoreConfig
  | PgVectorStoreConfig
  | HanaVectorStoreConfig;

/** The embedders this library's resolver constructs itself (Task B6c's `EmbedderResolution` arms). */
const BUILT_IN_EMBEDDER_PROVIDERS = [
  'openai',
  'sap-ai-core',
  'sap-aicore',
  'ollama',
] as const;
export type BuiltInEmbedderProvider =
  (typeof BUILT_IN_EMBEDDER_PROVIDERS)[number];

export function isBuiltInEmbedderProvider(
  name: string,
): name is BuiltInEmbedderProvider {
  return (BUILT_IN_EMBEDDER_PROVIDERS as readonly string[]).includes(name);
}

/**
 * The serializable embedder section: a built-in named by `provider`, or a consumer-registered
 * factory named by `factory` — the same split as the library's `EmbedderResolution`, minus the
 * credential, which the composition root resolves from `credentialRef`.
 *
 * No `apiBaseUrl`: SAP AI Core's address travels with the credential from the same service key
 * (the root's credential entry), so it is never also written here — one source (spec §4.6.2,
 * §8 migration item 4). The YAML boundary refuses one by name.
 */
export type SmartServerEmbedderConfig =
  | {
      /** Default when a YAML section names neither: 'ollama'. */
      provider: BuiltInEmbedderProvider;
      model?: string;
      /** The embedder's own address (Ollama, an OpenAI-compatible endpoint). */
      url?: string;
      /** SAP AI Core resource group. */
      resourceGroup?: string;
      /** SAP AI Core scenario: 'orchestration' (default) or 'foundation-models'. */
      scenario?: 'orchestration' | 'foundation-models';
      /**
       * The model embeds stored text and search text differently (e.g.
       * `nvidia--llama-3.2-nv-embedqa-1b`). The server then builds TWO instances
       * on the same model — a document one for what it writes into stores, a
       * query one for what it searches with. SAP AI Core, orchestration only.
       */
      asymmetric?: boolean;
      /**
       * Which half of an asymmetric pair to build — set by the server for each
       * of the two instances, not by the YAML.
       */
      inputType?: 'document' | 'query';
      /**
       * Cap on texts per embedBatch call. Precedence: this value → the provider's
       * declared cap → the library default (100).
       */
      maxBatchSize?: number;
      /** The embedder's account; omit for the root's default embedder entry. */
      credentialRef?: string;
      factory?: never;
    }
  | {
      /** An `extraFactories` key the consumer registered; it receives `EmbedderFactoryConfig`. */
      factory: string;
      model?: string;
      url?: string;
      maxBatchSize?: number;
      provider?: never;
      /** A consumer factory closes over its own credential; the framework carries none for it. */
      credentialRef?: never;
    };

/**
 * The section for an embedder known only by name — the skill host's
 * `skillPlugins.embedder.provider`: a built-in name becomes `provider`, anything else
 * the `factory` it must have been registered as, and no name means ollama.
 */
export function embedderSectionFor(
  name: string | undefined,
  model?: string,
): SmartServerEmbedderConfig {
  const m = model !== undefined ? { model } : {};
  if (name === undefined) return { provider: 'ollama', ...m };
  return isBuiltInEmbedderProvider(name)
    ? { provider: name, ...m }
    : { factory: name, ...m };
}

export interface SmartServerRagConfig {
  store: SmartServerRagStoreConfig;
  /** Absent → no embedder: only an in-memory store works without one (keyword-only). */
  embedder?: SmartServerEmbedderConfig;
}

/**
 * What `BuildAgentDeps.makeRag` receives: the serializable store section and, where
 * the store needs one, an embedder already built through `resolveEmbedder`. Paired,
 * so the compiler demands an embedder exactly where a store cannot work without one.
 */
export type MakeRagInput =
  | { store: InMemoryStoreConfig; embedder?: IEmbedder }
  | {
      store: QdrantStoreConfig | PgVectorStoreConfig | HanaVectorStoreConfig;
      embedder: IEmbedder;
    };

/**
 * Narrows a `MakeRagInput` to its in-memory arm — and, in the `false` branch, to the vector
 * arm with `embedder: IEmbedder`. TypeScript does not narrow the pair through
 * `input.store.type` — the discriminant is nested — so without this a `makeRag` body sees
 * `embedder: IEmbedder | undefined` on every arm (§4.6.4's reference `makeRag` uses exactly
 * this guard). The one-line body restates the union's own pairing.
 */
export function isInMemoryInput(
  input: MakeRagInput,
): input is Extract<MakeRagInput, { store: { type: 'in-memory' } }> {
  return input.store.type === 'in-memory';
}

/**
 * Pair a store section with the embedder resolved for it. The embedder is a value
 * that exists or does not at runtime; the union makes the requirement visible, and
 * this is where a vector store without one is refused, naming what to configure.
 */
export function toMakeRagInput(
  store: SmartServerRagStoreConfig,
  embedder: IEmbedder | undefined,
  label: string,
): MakeRagInput {
  if (store.type === 'in-memory') {
    return embedder ? { store, embedder } : { store };
  }
  if (!embedder) {
    throw new Error(
      `${label}.store.type '${store.type}' needs an embedder: configure ${label}.embedder (provider, model)`,
    );
  }
  return { store, embedder };
}

/**
 * The boundary for a programmatic config no compiler saw (plain JS, or a cast): a
 * `rag` still in the flat shape is refused at construction with the migration in
 * the message, instead of failing later on `undefined.type`.
 */
export function assertRagConfigShape(rag: unknown, label: string): void {
  if (rag === undefined || rag === null) return;
  const store = (rag as { store?: unknown }).store;
  if (store === null || typeof store !== 'object') {
    throw new Error(
      `${label}.store is required: the flat rag section was split into ${label}.store ` +
        `and ${label}.embedder, each with its own credentialRef (see the migration note)`,
    );
  }
}
