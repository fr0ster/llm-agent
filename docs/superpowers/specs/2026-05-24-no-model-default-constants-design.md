# Remove hardcoded model-default constants (fail loud) — #136

> **Status:** Design, approved. Closes [#136](https://github.com/fr0ster/llm-agent/issues/136).
>
> **Release target:** v15.x (minor). Part of the 135/136/137 batch PR.

## Background / reframing

#136 originally proposed swapping the default embedder `nomic-embed-text` → `bge-m3` (multilingual) because non-English (UA/DE) queries surfaced the wrong MCP tools.

Investigation reframed it into two independent decisions:

1. **The shipped/recommended embedder should be multilingual (`bge-m3`) — always.** It robustly covers non-English **document** corpora, residual non-English after translation, and SAP-native German terms embedded in otherwise-English text. The query-translation step stays as a complementary normalization: before tool search the helper prompt translates the query to English, then we vectorize (with the multilingual embedder) and search RAG (`packages/llm-agent/src/rag/preprocessor.ts`, enabled by default via `ragTranslateEnabled != false`). Multilingual embedder + translate together = robust both for tool-selection and for non-English document corpora.
2. **No hardcoded model-default constant.** The model must be specified explicitly; a missing model fails loud (consistent with the #134 fail-loud / "no silent defaults" philosophy). "Multilingual always" is achieved by shipping `bge-m3` **explicitly** in the examples/template — NOT by a code constant. Code has no default; the recommended config does.

So #136 becomes: **(a) remove model-default constants (embedders AND LLM providers), require the model explicitly, fail loud; (b) make the shipped examples/template use the multilingual `bge-m3` ollama embedder explicitly.**

## Scope

### 1. Remove embedder model defaults
- `packages/ollama-embedder/src/ollama.ts:25` — `this.model = config.model ?? 'nomic-embed-text'` → require `config.model`; throw `OllamaEmbedder requires a 'model'` (or similar) when absent.
- `packages/openai-embedder/src/openai-embedder.ts:27` — `this.model = config.model ?? 'text-embedding-3-small'` → same: require explicit model.
- `sap-aicore-embedder` already requires model (no default) — leave as-is.

### 2. Remove LLM provider model defaults
- `packages/openai-llm/src/openai-provider.ts:32` — `this.model = config.model || 'gpt-4o-mini'` → require explicit model; throw when absent.
- `packages/deepseek-llm/src/deepseek-provider.ts:25` — drop `|| 'deepseek-chat'` in the `super({...})` call → require explicit model.
- `packages/anthropic-llm/src/anthropic-provider.ts:29` — drop `|| 'claude-3-5-sonnet-20241022'` → require explicit model.
- `ollama-llm` (`OllamaProvider extends OpenAIProvider`) has no own model default; it passes `config.model` through, so it inherits the new "model required" behavior automatically.
- Throw mechanism: a clear `Error` in the provider constructor (mirroring `BaseLLMProvider.validateConfig`'s apiKey check). Message names the provider + the missing `model` field.

### 3. Config validator — require `rag.model` when an embedder is used
In `config.ts` `validateResolvedConfig` (the `checkRagStore` helper added in #134/PR139), require `rag.model` (or the store's `model`) when the store actually uses an embedder — i.e. `rag.type` is a vector store OR (`in-memory` AND `embedder` set). This produces a clean batched startup error (`rag.model: required when an embedder is used`) instead of a deep constructor throw.
- `llm.model` is already required by the #134 validator (server path) — no change needed there; removing the provider constants makes direct library use fail loud too.

### 4. Examples / template — switch ollama embedder model to `bge-m3` (multilingual always)
- Replace `model: nomic-embed-text` → `model: bge-m3` in every YAML where the **ollama embedder** is used: the first-run `YAML_TEMPLATE` (config.ts), `examples/docker-ollama/`, `examples/docker-deepseek/` (its rag block uses the ollama embedder), and the `docs/examples/*.yaml` + `pipelines/*.yaml` that reference `nomic-embed-text`.
- Leave non-ollama embedder configs unchanged: SAP AI Core (`text-embedding-3-small`) and openai-embedder examples keep their explicit models.
- These are explicit `model:` values (not a code default) — the code still has no default; the shipped configs are simply multilingual out-of-the-box.
- READMEs / `ollama pull` instructions: update `ollama pull nomic-embed-text` → `ollama pull bge-m3` where they appear (`examples/docker-ollama/README.md`, `examples/docker-deepseek/README.md`, QUICK_START).

### 5. Docs
- `docs/PERFORMANCE.md` (+ short note in `docs/QUICK_START.md`): embedder-model guidance —
  - the embedder `model` is explicit (no code default);
  - the recommended ollama embedder is the **multilingual `bge-m3`** (`ollama pull bge-m3`) — used in all shipped examples. It covers non-English document corpora, residual non-English, and SAP-native German terms;
  - tool-selection additionally benefits from the **query-translation** step (`ragTranslateEnabled`, default on): the query is translated to English before vectorization and RAG search. Translate + multilingual embedder are complementary, not either/or;
  - **dimension caveat:** the embedder model determines vector dimensions (nomic-embed-text 768 vs bge-m3 1024). Switching models requires a **re-index** of persistent stores (qdrant/hana/pg); in-memory rebuilds each run. The `docs/PERFORMANCE.md` benchmark line ("Ollama nomic-embed-text") should be updated or annotated accordingly.

### 6. CHANGELOG (`[Unreleased]`)
- **Breaking:** embedder and LLM provider `model` no longer have hardcoded defaults — `model` must be set explicitly (server path already required `llm.model` since v15.0.0; this extends the same to embedders and to direct library use of providers). Missing model now fails loud.
- **Changed:** shipped examples/template now use the multilingual `bge-m3` ollama embedder instead of `nomic-embed-text`. Run `ollama pull bge-m3`. Persistent vector stores (qdrant/hana/pg) built with a previous embedder must be **re-indexed** (embedding dimensions differ: 768 → 1024).

## Out of scope
- No change of the actual default model value (we remove the default, not swap it). `bge-m3` is a documented recommendation only.
- LLM provider baseURL defaults (e.g. `https://api.openai.com/v1`) stay — they are endpoint identity, not model choice, and not the subject of this change.
- The classifier domain-neutrality (#135) and pipeline.rag embedder sharing (#141) are separate.

## Testing
- `ollama-embedder` / `openai-embedder`: unit test that constructing without `model` throws a clear error; with `model` set, `.model` is that value.
- LLM providers (openai/deepseek/anthropic): unit test that constructing without `model` throws.
- `config-validation.test.ts`: a rag block using an embedder (e.g. `type: in-memory, embedder: ollama`) WITHOUT `model` is rejected with `rag.model: required ...`; with `model` it passes. A bare `type: in-memory` (no embedder, no model) stays valid (BM25, no embedder → no model needed).
- Build + lint green; fix any existing test/usage that relied on an implicit model default by adding an explicit model.

## Acceptance criteria
1. No hardcoded model-default constant remains in any embedder or LLM provider (grep clean).
2. Constructing an embedder/provider without a model fails loud with a clear message.
3. Server config validator rejects an embedder-using rag block without `rag.model`.
4. Shipped examples/template still build and validate (they set model explicitly).
5. Docs explain the explicit-model rule + multilingual (bge-m3) guidance for non-English document corpora + the dimension caveat.
