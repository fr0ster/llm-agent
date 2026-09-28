# Migrating to v30.0.0

## TL;DR

- **Your embedder does not change.** Providers keep implementing `IEmbedder` (`embed`).
- **What you hand to a store or a search path does.** A store now takes an
  `IRetrievalEmbedder`, a search path an `IQueryEmbedder`. Give your embedder its roles once,
  where you build it:

  ```ts
  import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
  const embedder = symmetricEmbedder(myEmbedder);   // was: myEmbedder
  ```

- **YAML users (`llm-agent` / `SmartServer`) need no edit.** The server builds the retrieval
  embedder from `rag.embedder` as before.

## Why

A store does two jobs with an embedder: it **writes** records and it embeds the **search
text** it handles itself (a text-only query — every sub-agent's —, a preprocessed one, a failed
caller embedding). Some retrieval models embed the two differently:
`nvidia--llama-3.2-nv-embedqa-1b` refuses a call that does not say `type: document | query`.
With one `embed` method for both jobs nothing could tell them apart.

The jobs are now two methods with different names:

| Contract | Method | Used for |
|---|---|---|
| `IDocumentEmbedder` | `embedDocument(text)`, optional `embedDocuments(texts)` | text written into a store |
| `IQueryEmbedder` | `embedQuery(text)` | text a store is searched with |
| `IRetrievalEmbedder` | both | a store |

Because the names differ, the compiler refuses one role where the other is needed — no tag and
no runtime check. `symmetricEmbedder(e)` gives an `IEmbedder` both roles (one model, both jobs);
`asymmetricEmbedder({ document, query })` joins the two halves of an asymmetric model.

## What you do

| You pass … | Before v30 | v30 |
|---|---|---|
| an embedder to `VectorRag` | `new VectorRag(e, cfg)` | `new VectorRag(symmetricEmbedder(e), cfg)` |
| an embedder to `QdrantRag` / `PgVectorRag` / `HanaVectorRag` | `{ …, embedder: e }` | `{ …, embedder: symmetricEmbedder(e) }` |
| an embedder to a `*RagProvider` | `{ name, embedder: e }` | `{ name, embedder: symmetricEmbedder(e) }` |
| an embedder to `makeRag` | `{ type, embedder: e }` (composed for you) | `{ type, embedder: symmetricEmbedder(composeEmbedder(e)) }` |
| a query embedder | `new QueryEmbedding(text, e)` | `new QueryEmbedding(text, symmetricEmbedder(e))` |
| the builder's embedder | `.withEmbedder(e)` | `.withEmbedder(symmetricEmbedder(wrapEmbedder(e)))` |
| `SmartAgentDeps.embedder` | `e` | `symmetricEmbedder(wrapEmbedder(e))` |
| a skill-host resolver (`BuildSkillHostDeps.resolveEmbedder`) | returns `e` | returns `symmetricEmbedder(e)` |
| a controller's `ControllerFactoryDeps.embedder` | `e` | `symmetricEmbedder(e)` |
| `conformanceEmbedder()` to a store | `embedder: conformanceEmbedder()` | `embedder: symmetricEmbedder(conformanceEmbedder())` |

A custom store implementation (`implements IRag`) that embedded with `this.embedder.embed(…)`
takes an `IRetrievalEmbedder` and calls `embedDocument` when it writes, `embedQuery` when it
embeds search text.

### Things that moved

- **`makeRag` no longer composes the embedder.** It used to wrap chunking and retry onto the
  embedder it was given; it now takes the retrieval embedder as it is, and `RagResolution` has no
  `maxBatchSize`. Compose the `IEmbedder` underneath — `composeEmbedder(e, { maxBatchSize })` —
  before giving it its roles. (`resolveEmbedder` composes a built-in as before.)
- **`SmartAgent` and `SmartAgentBuilder.withEmbedder` no longer wrap for usage logging.** Put
  `wrapEmbedder` on the `IEmbedder` underneath, as `resolveAgentEmbedder` does.
- **Wrappers stay on `IEmbedder`.** `withRetry`, `withCircuitBreaker`, `composeEmbedder`,
  `composeResilientEmbedder`, `wrapEmbedder` take and return an `IEmbedder`; apply them first,
  then `symmetricEmbedder(...)` / `asymmetricEmbedder(...)`.

## An asymmetric model

```ts
import { asymmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { SapAiCoreEmbedder } from '@mcp-abap-adt/sap-aicore-embedder';

const embedder = asymmetricEmbedder({
  document: new SapAiCoreEmbedder({ ...config, inputType: 'document' }),
  query: new SapAiCoreEmbedder({ ...config, inputType: 'query' }),
});
```

With YAML: `rag.embedder.asymmetric: true` (SAP AI Core, orchestration scenario), and
`skillPlugins.embedder.asymmetric: true` for a dedicated skill embedder.
