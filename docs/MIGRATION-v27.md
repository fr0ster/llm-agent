# Migrating to v27.0.0

## TL;DR

- **Secrets left every config and contract.** Pass a *credential* object to the provider or store
  you construct. In YAML, name an account with `credentialRef:`. `apiKey: ${VAR}` is gone.
- **The `llm-agent` binary reads new variable names.** `LLM_API_KEY` / `LLM_SERVICE_KEY` replace
  `DEEPSEEK_API_KEY`, `AICORE_SERVICE_KEY` and friends (item 4).
- **The library no longer builds providers for you.** `makeLlm`, `makeDefaultLlm`, `MakeLlmConfig`
  and `DefaultModelResolver` are removed. `BuildAgentDeps.makeLlm`, `resolveEmbedder` and `makeRag`
  are **required**.
- **YAML changed shape in three places.** `rag:` splits into `store:` + `embedder:`. Controller
  subagents and DAG worker files name keys of the top-level `llm:` map.
- **Pipeline plugins take typed settings.** `parseConfig` is gone. `ctx.resolveNamedLlm(key)` is
  new, and a configurable plugin is exported as a factory.
- **RAG collections belong to one caller.** The collection tools are built for one identity. Every
  shipped store keeps a catalog (Qdrant ≥ 1.17). Re-creating a collection no longer reattaches it;
  hydration does.

Nothing here is deprecated-but-working. Every item below needs an edit or a check.

## Which items apply to you

| You… | Do items |
|---|---|
| run `llm-agent` (the binary) from YAML only | 4 (YAML part and **env names**), 8 (YAML part), 10, and "Also changed" |
| embed `SmartAgentBuilder` in code | 1, 2, 3, 9; 6 and 7 if you mount the RAG collection tools |
| embed `SmartServer` from `llm-agent-server-libs` | 1, 2, 3, 4, 5, 8, 9, 10, 11 |
| ship a pipeline plugin | 5, 8 |
| mount the RAG collection tools | 6, 7, 10 |
| implement `IPipelineContext` yourself (fixtures included) | 5 |
| implement `IRagRegistry` yourself | 10, 11 |
| read a logger option (`options.logger`) | 9 |
| call `makeRag` / `resolveEmbedder` from `llm-agent-rag` directly | 1, and "Also changed" below |

---

## 1. Replace a plain key with a credential

`apiKey` is gone from `LLMProviderConfig`, from `EmbedderFactoryConfig` and from the concrete
providers' own configs. `user`/`password` are gone from the pg and hana store configs. A static key
is already a credential, and core ships the conversion: `staticApiKey` and `staticLogin` come from
`@mcp-abap-adt/llm-agent`.

```ts
- new OpenAIProvider({ model: 'gpt-4o', apiKey: key });
+ new OpenAIProvider({ model: 'gpt-4o', credential: staticApiKey(key) });

- new OpenAiEmbedder({ model: 'text-embedding-3-small', apiKey: key });
+ new OpenAiEmbedder({ model: 'text-embedding-3-small', credential: staticApiKey(key) });

- new QdrantRag({ url, collectionName, embedder, apiKey: key });
+ new QdrantRag({ url, collectionName, embedder, credential: staticApiKey(key) });

- new PgVectorRagProvider({ name, embedder, connection: 'postgres://u:pw@host/db' });
+ new PgVectorRagProvider({
+   name,
+   embedder,
+   connection: {
+     connectionString: 'postgres://host/db',
+     credential: staticLogin('u', 'pw'),
+     collectionName: '_', // required by the type; the provider names each collection's table
+   },
+ });
```

- A connection string that carries a user and password is now **refused at construction**, and
  the message names `staticLogin`. It is not silently ignored.
- `hana-vector-rag` **requires** `credential`, because HANA has no anonymous login. A bare-string
  `HanaVectorRagProviderConfig.connection` is refused too.
- Your own embedder factory no longer receives `cfg.apiKey`. Close over the credential you
  already hold — that is why the framework no longer carries one.
- Your own `BaseLLMProvider` subclass: `validateConfig()` is gone (it only checked `apiKey`).
  Delete the `this.validateConfig()` call; declare `credential` required on your config instead.

## 2. Construct your LLM provider yourself, and hand in the instance

`makeLlm`, `makeDefaultLlm` and `MakeLlmConfig` are gone from `llm-agent-libs`: a dispatch that
restates five constructors it does not own belongs to the consumer.

```ts
- const llm = await makeLlm({ provider: 'openai', apiKey: key, model: 'gpt-4o' });
- builder.withMainLlm(llm);
+ const provider = new OpenAIProvider({ credential: staticApiKey(key), model: 'gpt-4o' });
+ builder.withMainLlm(new LlmAdapter(new LlmProviderBridge(provider), { model: provider.model }));
```

`DefaultModelResolver` is gone too. `IModelResolver` is **unchanged**. If you relied on the library's
implementation for `PUT /v1/config` model switching, implement the one-method contract where your
credential lives. `llm-agent-server` now does exactly this for the shipped server.

```ts
- new DefaultModelResolver({ provider: 'openai', apiKey: key })
+ const modelResolver: IModelResolver = {
+   async resolve(modelName, role) {
+     const provider = new OpenAIProvider({ credential: myCredential, model: modelName });
+     return new LlmAdapter(new LlmProviderBridge(provider), { model: provider.model });
+   },
+ };
```

- The library's per-role temperature (`main ? 0.7 : 0.1`) did not move. Choose your own.
- A per-call `CallOptions.model` is **not** a substitute. By its own contract it does not reach the
  reviewer, finalizer, planner or evaluator roles.

## 3. Build the SAP AI Core credential in your composition root

The SAP providers no longer read `AICORE_SERVICE_KEY`. A service key is OAuth client credentials,
not a token, so the exchange, its cache and its refresh live in one function you call:
`serviceKeyCredential` from the new `@mcp-abap-adt/sap-aicore-auth`.

```ts
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';

- new SapCoreAIProvider({ model });                    // read AICORE_SERVICE_KEY itself
+ const { credential, apiBaseUrl } = serviceKeyCredential(process.env.AICORE_SERVICE_KEY!);
+ new SapCoreAIProvider({ model, credential, apiBaseUrl });

- new SapAiCoreEmbedder({ model, credentials: { clientId, clientSecret, tokenUrl, apiBaseUrl } });
+ new SapAiCoreEmbedder({ model, credential, apiBaseUrl });
```

- It is the package's former `TokenProvider` and `parseServiceKey`, moved out with their tests.
  Behaviour is unchanged for a deployment that sets the same variable; your code now reads it, one
  level up.
- The providers' `credentials` option and its exported `SapAICoreCredentials` shape
  (`clientId`/`clientSecret`/`tokenServiceUrl`/`servicUrl` — spelled that way in the old type) are
  gone. The credential and `apiBaseUrl` above replace them.

## 4. Supply all three construction seams, and move your secrets to `credentialRef`

The library no longer defaults these seams. Without `makeLlm` there is no LLM, and startup refuses,
naming the missing seam.

**YAML (the binary):**

```yaml
  llm:
    main:
      provider: deepseek
-     apiKey: ${DEEPSEEK_API_KEY}
+     # nothing here: the role's default ref applies. A secret never enters the loaded config.
      model: deepseek-chat
    classifier:
      provider: openai
+     credentialRef: OPENAI_KEY_CHEAP     # name a second account only when you have one
      model: gpt-4o-mini
```

- `credentialRef` is optional **in each section on its own**. Omitting it means that role's default
  ref: `LLM` for an `llm:` entry, `RAG_STORE` for `rag.store`, `RAG_EMBEDDER` for `rag.embedder`.
- `rag.apiKey`, `rag.user`/`rag.password` and a qdrant `skillPlugins` store's `apiKey` all become
  `credentialRef` too.

### Environment variable names

**The binary reads new environment variable names — BREAKING for YAML-only deployments.** A ref names
a family of variables: `<REF>_API_KEY` (an API key), `<REF>_SERVICE_KEY` (a SAP AI Core service key) or
`<REF>_USER` + `<REF>_PASSWORD` (a login). The full contract is in
[`llm-agent-server` → Credentials](../packages/llm-agent-server/README.md#credentials).

| You set before | Set now (no `credentialRef`) | Or keep the old variable |
|---|---|---|
| `apiKey: ${DEEPSEEK_API_KEY}` (any provider, any variable name) | `LLM_API_KEY` | `credentialRef: DEEPSEEK` → reads `DEEPSEEK_API_KEY` |
| `AICORE_SERVICE_KEY` for `provider: sap-ai-sdk` | `LLM_SERVICE_KEY` | `credentialRef: AICORE` → reads `AICORE_SERVICE_KEY` |
| `AICORE_SERVICE_KEY` for a `sap-ai-core` embedder | `RAG_EMBEDDER_SERVICE_KEY` | `credentialRef: LLM` (share the LLM's) or `credentialRef: AICORE` in `rag.embedder` |
| an OpenAI embedder's `apiKey` | `RAG_EMBEDDER_API_KEY` | `credentialRef: <REF>` in `rag.embedder` |
| a Qdrant `rag.apiKey` | `RAG_STORE_API_KEY` (optional: unset means anonymous) | `credentialRef: <REF>` in `rag.store` |
| user and password inside a pg/hana `connectionString` | `RAG_STORE_USER` + `RAG_STORE_PASSWORD` | `credentialRef: <REF>` in `rag.store` |

- Ollama gets a credential only from a ref that **names** one: the `LLM` default usually holds a
  hosted provider's key, and it is never sent to whatever sits at an Ollama URL. An Ollama embedder
  and an in-memory store take none, and naming a ref for them is refused.
- Several kinds set for one ref (for example `LLM_API_KEY` and `LLM_SERVICE_KEY`) are refused: an
  entry holds one credential.

### Code seams (`SmartServer` / `BuildAgentDeps`)

`makeLlm`, `resolveEmbedder` and `makeRag` are all required. Passing `{}` as `deps` stops compiling,
and every call site, tests included, names the seams. `llm-agent-server` carries the reference
implementation (`packages/llm-agent-server/src/composition/`). Copy it rather than writing your own:

- one `credentialFor(ref)`, **memoized**, so a ref always returns the **same** credential object —
  that identity keys the 429 quota bucket;
- one `lookup(ref, roleDefault, target)` with `require` / `optional` / `requireApiBaseUrl` /
  `refuseAny`, where "optional" means a ref may be **omitted**, never that a **named** ref may fail
  to resolve;
- one default ref per role, read only when a target asks for a credential, so an in-memory store or
  an Ollama embedder never parses it;
- `apiBaseUrl` travels with the SAP credential from the same service key, so the YAML never carries
  one;
- the knobs the library's `makeLlm` forwarded (`temperature`, `maxTokens`, `whenThrottled`,
  `baseURL`) and the model listing (`getModels`, which `GET /v1/models` reads) are part of the seam.

A deployment that authenticates nothing (for example Ollama plus in-memory) still writes all three
seams:

- `resolveEmbedder` and `makeRag` remain the library's functions; what changes is who calls them and
  who owns the credential.
- `isInMemoryInput` is the one-line guard `input.store.type === 'in-memory'`, exported beside
  `MakeRagInput`.
- `InMemoryStoreConfig` carries `credentialRef?` so that a ref named for a store that takes none is
  refused by name.

### Split `rag:` in two

The old shape held a store's settings beside an embedder's, with `url`
meaning either one's address, so one `credentialRef` could not say which target it named:

```yaml
# before
rag:
  type: qdrant
  url: http://localhost:6333
  collectionName: docs
  apiKey: ${QDRANT_API_KEY}
  embedder: openai
  model: text-embedding-3-small
  dedupThreshold: 0.95

# after
rag:
  store:
    type: qdrant
    url: http://localhost:6333
    collectionName: docs
    credentialRef: QDRANT
  embedder:
    provider: openai
    model: text-embedding-3-small
    credentialRef: OPENAI
```

- `dedupThreshold`, `vectorWeight` and `keywordWeight` move under `store:`, and only for
  `type: in-memory`, the one store that reads them. Beside another store type they did nothing
  before either, so delete them there.
- For keyword-only retrieval, write `store: { type: in-memory }` with no `embedder:` section.
- A qdrant `skillPlugins` store does **not** split: it already keeps its embedder separately. It
  only gains `credentialRef`.
- `PipelineRagStoreConfig` and `PipelineLlmProviderConfig` are **deleted**, not reshaped. Nothing
  has read them since v19.

## 5. Stop constructing inside the pipeline: name the model, resolve the instance

`IServerPipelineContext` loses `makeLlm`, `llmMap` and `pipelineFallback` (the last was always
`undefined`). `IRoleLlmResolver` loses `makeLlm(lc)`.

```ts
- const llm = await ctx.makeLlm({ provider: 'openai', model: 'gpt-4o-mini' });
+ const llm = settings.plannerKey
+   ? await ctx.resolveNamedLlm(settings.plannerKey)   // a key the file named: strict, throws if absent
+   : await ctx.resolveLlm('planner');                 // no key: the role's own name, falls back to main
```

- Use `resolveNamedLlm` for anything a file named. `resolveLlm` answers an unknown name with `main`,
  which would turn a misspelled key into a silent model change.
- If you implement `IPipelineContext` yourself, add `resolveNamedLlm(key)`. Test fixtures need it
  too.
- The instance comes from the server, which hands back the current one after a `PUT /v1/config`
  swap. **Do not take an `ILlm` in your plugin's constructor**: that would freeze the model against
  a swap.
- **Do not reach for a per-call `model`.** It does not reach the reviewer, finalizer, planner or
  evaluator, which are exactly the roles a controller or DAG path builds.
- Constructing a provider mid-pipeline from a config assembled at runtime is the capability this
  release removes on purpose. Add the model to `llm:`, or register it in your composition root, and
  resolve it by key.
- If the credential is the **caller's** rather than the deployment's, register it in a
  session-scoped resolver that disposes what it built when the session ends. The shipped
  `SmartServer` uses the deployment scope only: its sessions carry no caller credential.

## 6. Build the RAG collection tools with an identity

The identity is the caller the pipeline is being built for — the one whose collections the tools
may address.

```ts
- const entries = buildRagCollectionToolEntries({ registry });
+ const entries = buildRagCollectionToolEntries({ registry, identity });
+ // optional: attributes your policy needs on collections the model creates
+ const withPolicy = buildRagCollectionToolEntries({ registry, identity,
+   attributesFor: ({ name, scope }) => ({ authorization: 'owner', createdVia: 'tool' }) });
```

- `identity` is required. There is no overload without it: an optional `identity` would mean "do not
  narrow", reached by forgetting a field.
- The framework records what `attributesFor` returns and never reads it. Absent → no attributes.

## 7. Stop reading identity from the tool context

`RagToolContext` no longer declares `sessionId?`/`userId?`: the entries were built for one caller, so
the owner comes from the bound identity. A caller that *passes* them still compiles, and the values
are ignored. A caller that *reads* them gets `TS2339` or `TS2322`.

`rag_create_collection` no longer creates `global` collections. Its `scope` is `session | user`.
Create a deployment's shared collections in your own code, behind whatever check you apply:

```ts
await registry.createCollection({ providerName, collectionName, scope: 'global' });
```

A collection **shared by several users** is a `global` collection with your own role-based access
around it — `user`/`session` collections belong to one caller, so a registry holding them serves one
caller.

## 8. Construct your pipeline plugin with typed settings, drop `parseConfig`, point subagents at `llm:` keys

```ts
- const plugin: IPipelinePlugin<MyConfig> = {
-   name: 'my-pipeline',
-   parseConfig(raw) { return parse(raw); },
-   async build(config, ctx) { … },
- };
- export const pipelinePlugins = { 'my-pipeline': plugin };
+ class MyPipeline implements IPipelinePlugin {
+   readonly name = 'my-pipeline';
+   constructor(private readonly settings: MySettings) {}
+   async build(ctx: IPipelineContext) { … }
+ }
+ export const pipelinePluginFactories = {
+   'my-pipeline': (raw: unknown) => new MyPipeline(parseMySettings(raw)),
+ };
```

- The contract is `name` + `build(ctx)`. The plugin reads no configuration.
- Its constructor takes a **typed settings object**: knobs, kinds, and the **keys** naming which
  `llm:` entry each role uses. Whoever constructs it parses and validates it.
- At `build(ctx)`: a key the settings **named** → `ctx.resolveNamedLlm(key)`; a role whose key was
  **omitted** → `ctx.resolveLlm(role)` with the role's own name. Never the other way round.
- An LLM configuration or a `credentialRef` never reaches the plugin; a key is only a value.
- A dynamically loaded plugin that needs settings exports a **factory** under
  `pipelinePluginFactories`, `(raw: unknown) => IPipelinePlugin`, parsing its own shape. It is
  assembly code you ship beside the plugin. Its YAML section carries no secret and no
  `credentialRef`, because nothing on the server resolves one for it.
- A plugin that needs no settings keeps a plain `pipelinePlugins` instance export (among the shipped
  ones, only `flat`).
- A plugin's `name` must equal its export key. The loader now **refuses** a mismatched instance and
  reports it in `errors`, and startup refuses a mismatched factory result. It no longer skips a
  malformed export silently.
- Every instance comes through `ctx`, never through the constructor: the registry constructs the
  plugin once, process-wide.
- A plugin that needs an authorized backend `ctx` cannot get one from the file or its constructor.
  The remedy is a named, typed `ctx` capability; `ctx` offers no credential lookup.

**YAML:** controller subagents and DAG worker files name keys of the main file's `llm:` map:

```yaml
# before
pipeline:
  name: controller
  config:
    subagents:
      planner:   { provider: openai, model: gpt-4o-mini, apiKey: ${OPENAI_API_KEY}, hint: … }
      executor:  { provider: sap-ai-sdk, model: anthropic--claude-4.5-sonnet }
      evaluator: { provider: openai, model: gpt-4o-mini, apiKey: ${OPENAI_API_KEY} }

# after
llm:
  main:  { provider: sap-ai-sdk, model: anthropic--claude-4.5-sonnet }
  cheap: { provider: openai, model: gpt-4o-mini, credentialRef: OPENAI }
pipeline:
  name: controller
  config:
    subagents:
      planner:   { llm: cheap, hint: … }
      executor:  {}              # the role's own name: llm.executor if present, else main
      evaluator: { llm: cheap }  # the same instance the planner uses
```

```yaml
# a DAG worker's own file (subagents: [{ name, config: ./worker.yaml }])
- llm:
-   main: { provider: openai, model: gpt-4o-mini, apiKey: ${OPENAI_API_KEY} }
+ llm: cheap                   # or { main: cheap, helper: …, classifier: … }
```

- An omitted `llm` means the role's own name (`planner`, `executor`, …), resolved like any key —
  what `linear` and `stepper` already do.
- An absent `reviewer` or `finalizer` block keeps meaning "the planner's".
- `hint` stays where it was.
- A per-role temperature moves onto the `llm:` entry: a role that wants a colder model names a
  colder entry.
- An inline LLM configuration in a worker file is refused. A key with no `llm:` entry is refused at
  startup.
- **Behaviour change, from the same move:** a worker with no `helper` now gets the server's helper
  (or `main`), where it used to get none. Its classifier is the server's classifier, not a colder
  copy of its own main. Name an entry if you want the old behaviour.

## 9. Narrow a widened logger option before reading it

Six readable option properties accept `ILogger | ITextLogger`. A consumer that only *passes* a logger
is unaffected; one that *reads* an option must narrow first. The guarded form is the one that
compiles: the property is optional, so `normaliseLogger(options.logger)` alone fails with `TS2345`.

```ts
- options.logger.log(event);
+ if (options.logger) normaliseLogger(options.logger).log(event);
```

## 10. Give each store's account the rights its catalog needs, and handle the new errors

`qdrant-rag`, `pg-vector-rag` and `hana-vector-rag` now keep a small catalog of their own beside the
collections. `createCollection` creates it if absent and writes a record; `deleteCollection` deletes
the record **before** the data.

- **Rights.** The account a store's credential names must be able to create and write the catalog,
  or `createCollection` fails where it used to succeed. The catalog's form is each provider's own (a
  table, a collection), so each package documents what to grant:
  [pg-vector-rag](../packages/pg-vector-rag/README.md), [hana-vector-rag](../packages/hana-vector-rag/README.md),
  [qdrant-rag](../packages/qdrant-rag/README.md).
- **`autoCreateSchema: false`.** No DDL on creation — `deleteCollection` still drops the collection's
  own table. The catalog table itself is created by the operator with the statement the package
  exports, `createCatalogTableSql`.
- **Qdrant 1.17 or later** is required for a catalogued Qdrant store: the record is written with an
  insert-only operation, so a record's creation loses cleanly to a concurrent one.
- **`CatalogRecordDeleteError`** (`RAG_CATALOG_RECORD_DELETE`) is a new way for `deleteCollection` to
  fail: the record could not be removed, so nothing was deleted and the collection is still
  registered. Retry it.
- **A taken name is refused.** `RAG_DUPLICATE_COLLECTION` if a record exists, `RAG_ORPHAN_STORE` if a
  store exists without one. Creating the same (scope, owner, name) again works only after its
  deletion has finished.
- **`qdrant-rag` creates the collection at `createCollection`**, not on the first write, and spends
  **one embedding call** per collection created to learn the vector size.
- **Scope.** A name held in several scopes of one registry must be addressed with its `scope` — by the
  tools and by `get`/`getEditor`/`unregister`/`deleteCollection` — or the call fails with
  `RAG_AMBIGUOUS_COLLECTION`. If you implement `IRagRegistry` yourself, accept that optional `scope`.
- **Collections created by v26.x** have a store and no record, so creating one again is refused
  with `RAG_ORPHAN_STORE` naming the store. Call `createCollection` for it once with
  `adoptExisting: true`, which records the existing store; it hydrates like any other from then on.
- **Collections from v25 or earlier** sit under their logical name, where the registry never looks.
  Reach one with the provider's own `createCollection(oldName, { adoptExisting: true })`.
- **`ragStores` names.** A stage configuration that named a user or session collection by its bare
  name now names `user/<name>` or `session/<name>`. Globals — `tools`, `history`, every configured
  store — keep their names, **except** one whose name begins with `user/` or `session/`, which is
  refused at registration (`RAG_RESERVED_COLLECTION_NAME`) and must be renamed.
- Collections created before this release read back `attributes` as `undefined`.

The shared-collection model is the same one item 7 states: a collection several users share is a
`global`, and a registry holding `user`/`session` collections serves one caller.

## 11. Reattach collections after a restart by hydrating them, not by creating them again

Until now a fresh registry got a `user` or `global` collection back by calling `createCollection`
with the same identity. That call is now refused — `RAG_DUPLICATE_COLLECTION` with a record,
`RAG_ORPHAN_STORE` without — so an assembly that re-creates its collections at startup must read the
catalog and adopt what it finds, for the records that belong to the caller whose registry it builds:

```ts
import type {
  IRagProvider,
  IRagRegistry,
  RagCollectionRecord,
  RagError,
  Result,
} from '@mcp-abap-adt/llm-agent';

/** The caller whose registry you are building. */
type Caller = { sessionId: string; userId?: string };

function unwrap<T>(result: Result<T, RagError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** A caller's own collections; globals are hydrated once, into your deployment-wide registry. */
function belongsTo(caller: Caller) {
  return (record: RagCollectionRecord): boolean =>
    (record.scope === 'user' && record.userId === caller.userId) ||
    (record.scope === 'session' && record.sessionId === caller.sessionId);
}

export async function hydrate(
  provider: IRagProvider,
  registry: IRagRegistry,
  caller: Caller,
): Promise<void> {
  if (!provider.describeCollections || !provider.openCollection || !registry.adopt) return;
  const { records } = unwrap(await provider.describeCollections());
  for (const record of records.filter(belongsTo(caller))) {
    const { rag, editor } = unwrap(await provider.openCollection(record));
    // providerName: without it a later delete never reaches the provider, and the collection returns
    registry.adopt(record, rag, editor, provider.name);
  }
}
```

A collection created by v26.x has no record: adopt it once with `createCollection(…, { adoptExisting: true })`
(item 10), after which it hydrates like any other.

**Per-session hydration is unreachable in the shipped `SmartServer` today.** It builds each session's
registry through `ragRegistryFactory`, and that code hydrates — but from a provider registry that is
private to the server, and no option, YAML key or method registers a provider in it. So there is no
catalog to read, and each session's registry holds only the deployment's globals. Its sessions also
carry a `sessionId` and **no `userId`**, so `user` collections would be neither hydrated nor
creatable through it.

To hydrate, wire the providers yourself: call `buildSessionRagRegistry({ identity, globals, providers })`
from `@mcp-abap-adt/llm-agent-server-libs` with a provider registry you own — in your own
`SessionLifecycleOptions.ragRegistryFactory` — or run the `hydrate` above.

---

## Also changed (no numbered item — check your deployment)

- **A `dag` planner key now has to exist.** `plannerLlm: helper`, or `planner` with no `llm:` entry
  of that name, used to fall back quietly; a named key is now resolved strictly and refused at
  startup. An **omitted** `dag` planner key now resolves as the role name `planner` — the helper when
  one is configured — where it used to get `main`.
- **A configured embedder URL now arrives.** The old resolution passed `url`, while the Ollama
  embedder reads `ollamaUrl` and the OpenAI one `baseURL`, so a configured embedder URL was silently
  ignored. Each provider now gets its own field. A deployment that set one and never noticed it was
  unused now reaches it.
- **`llm-agent-rag`'s resolution API is typed per target.** `resolveRag` and the flat
  `RagResolutionConfig` are gone for the `RagResolution` union. Embedder resolution takes
  `EmbedderResolution`, a union discriminated by `provider` (formerly `embedder`), with a consumer
  factory named by its own `factory` arm; an embedder you already hold is wrapped with
  `composeEmbedder`. A leftover `apiKey`/`user`/`password` from an untyped source (a loaded YAML object)
  is refused at resolution, naming the target.
- **An `llm:` entry without a `temperature` no longer inherits main's.** Role entries reach the
  composition root as written; main and classifier keep `temperature`/`classifierTemperature`. Set a
  `temperature` on any other entry that relied on inheriting it.
- **A declared `llm.classifier` is now used.** The held classifier was always built from `llm.main` at
  `classifierTemperature`, so a `classifier` entry — its model and its `credentialRef` — was validated and
  ignored. It is now built from that entry when declared.
- **`PUT /v1/config` model switching works in the shipped server.** It needs an `IModelResolver`,
  which the binary never set, so the route answered 400. The composition root now supplies one.
- **Each `SmartServer` session owns its collection registry** (`ragRegistryFactory`), instead of
  sharing one process-wide registry. Not an edit, but a changed runtime (see item 11 for its limits).

## New and optional (decline freely)

`IMcpServer` with `withMcpServers` and `mcpServerFactory`; the typed `HttpMcpServer` and
`StdioMcpServer` in `llm-agent-mcp`; the `closePipeline` hook; `ragRegistryFactory`;
`describeCollections` / `openCollection` / `adopt`; `ITextLogger` acceptance. A consumer that uses
none of them keeps today's behaviour on those paths. See the root [CHANGELOG](../CHANGELOG.md).
