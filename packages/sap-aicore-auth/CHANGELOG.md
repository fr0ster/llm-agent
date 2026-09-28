# @mcp-abap-adt/sap-aicore-auth

## 30.0.0

**BREAKING — see docs/MIGRATION-v30.md.** Embedders have two roles told apart by method name: `IDocumentEmbedder.embedDocument` (text written into a store) and `IQueryEmbedder.embedQuery` (text a store is searched with), `IRetrievalEmbedder` for both. Stores, collection providers and `makeRag` take an `IRetrievalEmbedder`; search paths (`QueryEmbedding`, `withEmbedder`, `SmartAgentDeps.embedder`) an `IQueryEmbedder` — give a provider's `IEmbedder` its roles with `symmetricEmbedder(e)` or `asymmetricEmbedder({ document, query })`. Asymmetric SAP AI Core models (`nvidia--llama-3.2-nv-embedqa-1b`) via `SapAiCoreEmbedder.inputType` and `rag.embedder.asymmetric` / `skillPlugins.embedder.asymmetric`. `llm.resourceGroup` now reaches SAP AI Core (refused on other providers). Examples move from the retired `anthropic--claude-3-haiku` to `anthropic--claude-4.5-haiku`.

## 29.0.0

**BREAKING.** Sampling knobs a config does not set are no longer sent: `SmartServer` no longer defaults `temperature` to 0.7 (main) / 0.1 (classifier, helper), and the SAP AI Core, OpenAI, DeepSeek, Ollama and Anthropic providers no longer invent `temperature` (or, except Anthropic, whose API requires it, `max_tokens`) — the model applies its own default, so `gpt-5*`, `o1`/`o3`/`o4-mini` and `claude-opus-4-7`/`4-8`, which accept only temperature 1, now work. `@mcp-abap-adt/llm-agent-server` ships only the `llm-agent` command; `llm-agent-check` and `claude-via-agent` are repository tools (`npm run models:check`, `npm run claude:via-agent`). `@mcp-abap-adt/sap-aicore-llm`: the model catalog is queried with the configured credential, `getEmbeddingModels()` matches the catalog's `embedding` capability, and errors carry AI Core's reason. See docs/MIGRATION-v29.md.

## 28.0.0

**BREAKING (install contract only — no API change).** Every `@mcp-abap-adt/*` package this library uses — ours (`llm-agent`, `llm-agent-mcp`, …) and the shared `interfaces-auth` (`^2.1.0`) / `interfaces-utils` (`^1.1.0`) — is now a **peer dependency**, with the same range in every package, so a consumer's install holds exactly one copy of each. A version outside the range fails the install with `ERESOLVE` instead of nesting a second copy. `@mcp-abap-adt/llm-agent-server` (the binary) keeps them as regular dependencies. Also includes the minor/patch dependency updates of #311 (`@sap/hana-client` 2.30, `zod` 4.6, `@sap-ai-sdk/*` 2.16, `yaml` 2.9.1, `@modelcontextprotocol/sdk` 1.30.1; published ranges raised accordingly) and the dev tooling of #309. 27.0.2 was tagged but never published; its change is part of this release. See docs/MIGRATION-v28.md.

## 27.0.1

Node 26 is supported and now tested in CI alongside 22 and 24 (#312). No code changes.

## 27.0.0

Credentials leave every contract; RAG collections get an identity; every store honours the session, user, namespace and TTL filters (#308). Breaking — see [docs/MIGRATION-v27.md](https://github.com/fr0ster/llm-agent/blob/main/docs/MIGRATION-v27.md).

New package. `serviceKeyCredential(raw)` turns a raw SAP AI Core service-key JSON string into
`{ credential: IBearerCredential; apiBaseUrl: string }`. The credential runs the OAuth client-
credentials exchange and caches and refreshes its token; `parseServiceKey` is exported for callers
that need the fields. Both moved here from `sap-aicore-embedder`, with their tests, so the two SAP
packages and a composition root share one implementation.

`parseServiceKey`'s errors say "service key is not valid JSON" / "service key is missing required
fields" and name no environment variable: the parser cannot know which variable held the key, so
naming one (it used to say `AICORE_SERVICE_KEY`) misled whoever set another.
