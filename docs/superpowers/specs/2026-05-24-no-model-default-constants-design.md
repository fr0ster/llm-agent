# Remove hardcoded model-default constants (fail loud) — #136

> **Status:** Design, approved. Closes [#136](https://github.com/fr0ster/llm-agent/issues/136).
>
> **Release target:** v15.x (minor). Part of the 135/136/137 batch PR.

## Background / reframing

#136 originally proposed swapping the default embedder `nomic-embed-text` → `bge-m3` (multilingual) because non-English (UA/DE) queries surfaced the wrong MCP tools.

Investigation reframed it:

1. **The pipeline already translates non-English RAG queries to English before retrieval** (`packages/llm-agent/src/rag/preprocessor.ts`, enabled by default in `default-pipeline.ts` via `ragTranslateEnabled != false`). MCP tool descriptions are English; the query is translated to English; so tool-selection is effectively EN↔EN and `nomic-embed-text` is adequate. A multilingual embedder is **not** needed for tool selection.
2. A multilingual embedder **does** matter for a **non-English document RAG corpus** (a realistic case the user can generate) — but that is the user's explicit choice per corpus, not a global default.
3. The deeper issue is the **hardcoded model-default constant** itself. The correct embedder depends on the corpus language, so there should be **no default** — the model must be specified explicitly, and a missing model fails loud (consistent with the #134 fail-loud / "no silent defaults" philosophy).

So #136 becomes: **remove model-default constants (embedders AND LLM providers); require the model explicitly; fail loud when absent.** `bge-m3` is documented as the multilingual recommendation for non-English document corpora, not baked in as a default.

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

### 4. Examples / template
- Keep examples explicit (they already set `model:` everywhere). The flat-template and example YAMLs that use the **ollama embedder** keep `model: nomic-embed-text` (fine for English tool-selection with translate on). Do NOT force `bge-m3` into examples.
- The first-run `YAML_TEMPLATE` (config.ts) already specifies `model: nomic-embed-text` explicitly — keep it (it's explicit, not a code default).
- No example relies on an implicit code default, so removing the constants does not break the shipped examples (verify by build + the example-validates checks).

### 5. Docs
- `docs/PERFORMANCE.md` (and a short note in `docs/QUICK_START.md`): add embedder-model guidance —
  - the embedder `model` is explicit (no default);
  - for **English** corpora (MCP tool descriptions, especially with `ragTranslateEnabled` on) `nomic-embed-text` is adequate;
  - for **non-English document** corpora use a multilingual embedder such as `bge-m3` (`ollama pull bge-m3`);
  - **dimension caveat:** changing the embedder model changes vector dimensions (e.g. nomic 768 vs bge-m3 1024); persistent stores (qdrant/hana/pg) require a **re-index** when switching. In-memory rebuilds each run.
- Note that translation (`ragTranslateEnabled`, default on) is why English tool-search works for non-English queries — so a multilingual embedder is a document-corpus concern, not a tool-selection one.

### 6. CHANGELOG (`[Unreleased]`)
- **Breaking:** embedder and LLM provider `model` no longer have hardcoded defaults — `model` must be set explicitly (server path already required `llm.model` since v15.0.0; this extends the same to embedders and to direct library use of providers). Missing model now fails loud.

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
