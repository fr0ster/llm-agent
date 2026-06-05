# Troubleshooting

A symptom-first index of problems you can hit while wiring this agent up against SAP AI Core, Qdrant, MCP and various YAML pipelines. Each entry has the same shape: **symptom → cause → fix**.

---

## SAP AI Core embedder

### `TypeError: fetch failed` on every embedding call

**Symptom.** On startup the log fills with `Tool vectorization failed for "<tool>": TypeError: fetch failed` while the LLM chat (`OrchestrationClient`) hits the same tenant successfully. Issue tracking: #116.

**Cause.** `@mcp-abap-adt/sap-aicore-embedder` v11.0.0 used `OrchestrationEmbeddingClient`, which only resolves embedding deployments under the `orchestration` scenario. Most tenants deploy embedding models (`gemini-embedding`, `text-embedding-3-small`) under the `foundation-models` scenario instead — the SDK can't find them and the fetch fails before it leaves the process.

**Fix.** Set `scenario: foundation-models` on the embedder/store. The embedder then bypasses the SDK and calls the AI Core REST inference API directly:

```yaml
rag:
  embedder: sap-ai-core
  scenario: foundation-models
  resourceGroup: default
```

Default remains `'orchestration'` to preserve v11.0.0 behavior for tenants that already had embedding models under that scenario.

---

### `SAP AI Core embeddings call failed: 404 Not Found`

**Symptom.** Token + deployment resolution succeed, but the actual embedding POST returns `404 {"error":{"code":"404","message":"Resource not found"}}` (Azure-OpenAI deployments) or `404 {"error":"NotFound","message":"The model 'embeddings' does not exist."}` (Gemini deployments).

**Cause.** SAP AI Core inference paths are not uniform across model families:

- **Azure OpenAI** (`text-embedding-3-small`, `text-embedding-3-large`) — `/embeddings?api-version=2023-05-15`.
- **Vertex AI / Gemini** (`gemini-embedding`) — `/models/<model>:predict`, body `{ instances: [{ content }] }`, response `{ predictions: [{ embeddings: { values } }] }`.

A plain `/embeddings` POST works for none of them.

**Fix.** The embedder auto-detects family from the model name (`^gemini` → Gemini, otherwise → Azure OpenAI) and chooses the correct path/body/response shape. If your tenant uses a non-default Azure API version, override:

```ts
new SapAiCoreEmbedder({ model: 'text-embedding-3-small', azureApiVersion: '2024-02-15-preview' });
```

For new model families not covered by `^gemini` heuristic, extend `detectFamily` in `packages/sap-aicore-embedder/src/foundation-embedder.ts`.

---

### `MissingProviderError: Provider 'sap-ai-core' is declared in config but package '@mcp-abap-adt/sap-aicore-embedder' is not installed`

**Symptom.** Server fails to start; the npm-workspace symlink to the embedder exists, the package builds, `dist/` is present — but the prefetch step still treats it as missing.

**Cause.** The CLI prefetch loop only looked at the flat `rag:` block and at `pipeline.rag.{name}` only when `type !== 'in-memory'`. Pipeline-mode YAMLs that declare `embedder` per store didn't contribute their embedder names to the prefetch set, so the dynamic import was never attempted before `makeRag` tried to call it.

**Fix.** Already fixed in `packages/llm-agent-server/src/smart-agent/cli.ts`: the prefetch now iterates `pipeline.rag.{name}` and adds each store's embedder/type, including the `in-memory + explicit embedder` case (which upgrades to VectorRag and still requires the peer).

---

### `Unknown embedder "sap-aicore". Register a factory or use: openai, ollama, sap-ai-core`

**Symptom.** YAML uses `embedder: sap-aicore` (no inner dash), the factory rejects it.

**Cause.** Both forms appear in user-facing docs and in the docker-compose defaults (`sap-aicore`), but only `'sap-ai-core'` was registered as a factory. The package-name and class-name lookup tables had both keys; the runtime registry didn't.

**Fix.** Both spellings are now registered as aliases in `builtInEmbedderFactories`. Either form works.

---

## Pipeline (`pipeline.rag.{store}`)

### Multi-store YAML config behaves like there's no RAG at all

**Symptom.** YAML uses `pipeline.rag.tools`, `pipeline.rag.facts`, etc. instead of a flat `rag:` block. On startup the `tools` store is empty, MCP tool vectorization either doesn't fire or writes into a different store, and the agent picks irrelevant tools (e.g. Goose's `extensionmanager__search_available_extensions`) instead of the actual MCP catalog.

**Cause.** `pipeline.rag` was only consumed by `check-models-cli` (the sanity-checker). At runtime `smart-server.ts` only handled the flat `cfg.rag` block; `pipeline.rag.{store}` entries were silently ignored, so no stores got registered with the agent and the auto-vectorizer wrote nothing.

**Fix.** Already fixed: `smart-server.ts` now iterates `pipeline.rag.{store}` and wires each entry into the builder — `tools` → `setToolsRag`, `history` → `setHistoryRag`, anything else → `addRagCollection`.

---

### `Startup aborted: model "<X>" is not available`

**Symptom.** Startup fails with a model-availability error from SAP AI Core, often with a 400 from `OrchestrationClient.chat`.

**Cause.** The model in `pipeline.llm.main.model` (or `LLM_MODEL_NAME` env) is not actually deployed under the *orchestration* scenario in your tenant. Common cases:

- Defaulting to `gpt-4o` while only `anthropic--claude-4.6-sonnet` is deployed.
- Using `claude-4.5-opus` (typo / wishful thinking — only `claude-4.5-sonnet` and `claude-4.6-opus` are commonly deployed).

**Fix.** List what your tenant actually has under the orchestration scenario, then put one of those names in YAML or `.env`:

```bash
node --env-file=.env -e "
const k = JSON.parse(process.env.AICORE_SERVICE_KEY);
(async () => {
  const t = await fetch(k.url + '/oauth/token', {
    method:'POST',
    headers:{Authorization:'Basic ' + Buffer.from(k.clientid + ':' + k.clientsecret).toString('base64'), 'Content-Type':'application/x-www-form-urlencoded'},
    body:'grant_type=client_credentials'
  }).then(r => r.json());
  const list = await fetch(k.serviceurls.AI_API_URL + '/v2/lm/deployments?scenarioId=orchestration&status=RUNNING', {
    headers:{Authorization:'Bearer ' + t.access_token, 'AI-Resource-Group':'default'}
  }).then(r => r.json());
  for (const r of (list.resources || [])) {
    const m = r.details?.resources?.backend_details?.model || r.model;
    console.log(r.id, '->', m?.name);
  }
})();
"
```

The same script with `scenarioId=foundation-models` lists embedding-model deployments.

---

## Qdrant

### Tool selection returns junk; the only matching tool is `extensionmanager__search_available_extensions`

**Symptom.** Server starts cleanly, no vectorization warnings in the log, but RAG-retrieved tool sets are nearly empty or completely irrelevant. Goose-style clients fall back to their internal tools because the SAP MCP catalog never makes it past retrieval.

**Cause.** Qdrant collections have an **immutable `vectors.size`** set at create-time. If the collection was first populated with one embedder (e.g. `gemini-embedding`, 3072-dim) and the runtime now uses another (e.g. `text-embedding-3-small`, 1536-dim), every `upsert` is silently dropped on the server side. Qdrant returns OK at the request level, but no points are actually stored. Retrieval then returns the few stale points (or nothing), and the LLM picks whatever vaguely-related tool *was* visible.

Diagnostic: `curl -sS http://localhost:6333/collections/<name> | jq '.result | {points_count, indexed_vectors_count, vector_size: .config.params.vectors.size}'` — if `vector_size` doesn't match your embedder's output dim, that's the problem.

**Fix.** Three layers:

1. **Per-embedder collection names.** The example yaml suffixes collection names with `${EMBEDDING_MODEL}`, e.g. `mcp_tools__text-embedding-3-small`. Switching embedder no longer reuses an incompatible collection.
2. **Fail-fast guard in `qdrant-rag`.** `_ensureCollection` now reads the existing collection's `vectors.size` and throws a clear `RagError` on mismatch instead of silently letting upserts disappear.
3. **For one-off recovery on an old collection,** drop and recreate:
   ```bash
   for c in mcp_tools experience_facts experience_feedback experience_state demo_literature demo_news demo_sap_cases; do
     curl -s -X DELETE http://localhost:6333/collections/$c
   done
   ```

---

### Tests / local dev require Qdrant to be running

**Symptom.** `npm run dev:sap-ai-core` either fails to write to a non-existent Qdrant or blocks on connection retries.

**Cause.** The example YAML hardcoded `type: qdrant` for every store, mirroring the docker-compose recipe.

**Fix.** `RAG_TYPE` now defaults to `in-memory` in `examples/docker-sap-ai-core/smart-server.yaml`. Persistent storage is opt-in via env (`RAG_TYPE=qdrant`); docker-compose sets that explicitly. Local dev runs without any external vector DB.

---

## CLI / configuration

### CLI generates a fresh `smart-server.yaml` and exits

**Symptom.** Running `npm --prefix packages/llm-agent-server run dev` (from the repo root) prints `No config file found. Created smart-server.yaml with defaults.` and exits. A *different* `smart-server.yaml` appears inside `packages/llm-agent-server/`.

**Cause.** The CLI looks for `smart-server.yaml` in the **current working directory**. `npm --prefix <pkg>` runs the script with cwd set to that package directory, so the CLI doesn't see the `smart-server.yaml` at the repo root.

**Fix.** Use the root-level scripts that pass an absolute path:

```bash
npm run dev                 # default smart-server.yaml at the repo root
npm run dev:ollama          # examples/docker-ollama/smart-server.yaml
npm run dev:deepseek        # examples/docker-deepseek/smart-server.yaml
npm run dev:sap-ai-core     # examples/docker-sap-ai-core/smart-server.yaml
npm run dev -- --config <path>   # any custom path
```

---

### Environment variables in YAML resolve to empty strings

**Symptom.** `provider: ${LLM_PROVIDER}` resolves to empty, the LLM init blows up immediately with a 400, or the agent uses unexpected defaults.

**Cause.** Docker-compose sets defaults via `${VAR:-fallback}` syntax in its own env block, but when the same YAML is run from a host shell those defaults aren't applied — the YAML expression `${LLM_PROVIDER}` (no `:-default`) collapses to empty if the env var isn't set.

**Fix.** Every example YAML now uses `${VAR:-default}` directly inside the YAML; defaults are sensible for local-host runs (`localhost` URLs, `sap-ai-sdk` provider, common model names). For docker-compose, the compose env still overrides where needed. `.env.template` files in each example folder list the variables you need to override.

---

## RAG retrieval quality

### English-only embedder returns junk for non-English queries

**Symptom.** Tool descriptions are in English, the user query is in Ukrainian/Polish/etc., RAG returns very few or no relevant tools — model can't find a sensible action and either invents one or asks the user.

**Cause.** Most OpenAI-family embedders (`text-embedding-3-small`, `text-embedding-3-large`) are predominantly English-trained. Cross-lingual cosine similarity against English tool descriptions is poor.

**Fix.** The agent already invokes `_toEnglishForRag` (helper LLM translation) before embedding the query for the `tools` store specifically. Make sure:

- The helper LLM (`pipeline.llm.helper`) is configured and the model is deployed.
- `_toEnglishForRag` returns the translation, not the original. If translation fails, the function silently falls back to the original — add a `console.warn` on `!res.ok` while debugging.

If translation chain is unreliable, use a multilingual embedder instead — `bge-m3` (Ollama, recommended; set `model: bge-m3` explicitly) or `gemini-embedding` (SAP AI Core, multilingual). Both produce comparable cross-lingual similarity without translation.

---

## Rate limiting

### SAP AI Core returns 429 / quota errors during startup tool-vectorization

**Symptom.** A burst of `Tool vectorization failed ... 429 Too Many Requests` warnings on startup; some tools never make it into the RAG store.

**Cause.** `embedBatch` does send a single HTTP call for many inputs, but tool vectorization currently iterates tools one-by-one (`embedder.embed(text)`) when no batched writer interface is available, with no inter-call throttle. SAP AI Core enforces per-deployment rate limits.

**Fix (current).** Retry with exponential backoff is configured in YAML under `agent.retry`. That handles transient 429s but not sustained throttling. For sustained limits:

- Reduce the MCP tool count (limit the connected MCP server's exposed tool set).
- Use a less rate-limited embedding-model deployment.
- Open a follow-up to expose a configurable `embedder.throttleMs` option in `sap-aicore-embedder` and a YAML-driven `agent.rateLimiter` for the LLM.

---

## MCP / streaming runtime

### Streaming chat returns an empty response on every tool-using request

**Symptom.** With a tool-capable model and `stream: true`, the agent log shows `finishReason: 'tool_calls'` but `toolCalls: []` and `responseLength: 0`. The model wanted to call a tool, but nothing was dispatched and the client gets an empty stream. Issue tracking: #119.

**Cause.** `@mcp-abap-adt/llm-agent@11.0.0–11.1.0` (the 10.x provider split) — the per-provider streaming paths in `sap-aicore-llm`, `openai-llm`/`deepseek-llm`, and `anthropic-llm` never populated the normalized `LlmStreamChunk.toolCalls` field. `LlmProviderBridge` accumulated tool deltas only from the OpenAI raw shape (`choice.delta.tool_calls`), so SAP AI SDK chunks (`getDeltaToolCalls()`) and Anthropic SSE blocks (`tool_use` / `input_json_delta`) were silently dropped.

**Fix.** Upgrade to `>=11.1.1`. All four providers now emit normalized `toolCalls` deltas during streaming and the bridge accumulates from the normalized field — provider-specific raw shapes are no longer special-cased. Anthropic also normalizes `stop_reason: 'tool_use'` → `finishReason: 'tool_calls'`.

---

### MCP server unreachable but the agent boots silently

**Symptom.** Server starts cleanly with `event: server_started`, `/health` returns `mcpReachable: false` (or `mcp: []`), tool-using requests return "I don't have that tool" — and there is no log line explaining *why* the MCP wasn't connected. Issue tracking: #118.

**Cause.** `SmartAgentBuilder.build()` (then in `@mcp-abap-adt/llm-agent-server@11.0.0–11.1.0`; now in `@mcp-abap-adt/llm-agent-libs` since v12) wrapped the per-MCP-config setup loop in a bare `catch {}` with no binding and no log call. Connect failures (unreachable host, bad auth, 127.0.0.1 vs container gateway, blocked port) and post-connect failures (tool vectorization throwing) were equally invisible.

**Fix.** Upgrade to `>=11.1.1`. The catch now emits a `warning` log entry — `MCP setup failed for <url-or-command>: <error message>` — matching the pattern used elsewhere in the same file. Graceful-degradation behavior is preserved (the agent still builds without that MCP server). For one-off diagnosis on older versions, run a probe inside the container:

```bash
docker exec <core> node -e 'import("@mcp-abap-adt/llm-agent-mcp").then(async ({MCPClientWrapper})=>{const w=new MCPClientWrapper({transport:"auto",url:process.env.MCP_SERVER_URL,headers:{Accept:"application/json, text/event-stream"}});try{await w.connect();console.log("OK")}catch(e){console.error("ERR:",e.message)}})'
```

---

## Coordinator / multi-agent orchestration

### Response body is "(no response)" and usage tokens are all zero

**Symptom.** HTTP response `choices[0].message.content` is literally `"(no response)"` (or empty); `prompt_tokens`, `completion_tokens`, and `total_tokens` are all 0; `request_done ok:true` appears in `smart-server.log` after ~50–100 ms; no `coordinator_plan` or `coordinator_step_*` events appear between `request_start` and `request_done`.

**Cause.** The Coordinator stage ran, found `ctx.subAgents` undefined (the subagent registry was not propagated to the runtime `PipelineContext`), set `ctx.error`, and returned `false`. The pipeline aborted silently because the executor does not escalate failed-stage errors as stream chunks.

**Fix.** Ensure you are running version 12.0.6 or later — PR #129 includes the `_buildContext` fix. If you are on a fork, verify that `DefaultPipeline._buildContext()` assigns `ctx.subAgents = this.subAgents`.

---

### Coordinator-bearing pipeline stays inactive

**Symptom.** `coordinator_configured` event appears in `smart-server.log` at startup. Live requests show no `coordinator_plan` / `coordinator_step_*` events, but `tool-loop iteration 1` warnings do. Response content looks like a normal tool-loop reply.

**Cause.** Either no coordinator-bearing pipeline is selected (the default `flat` pipeline is single-shot tool-loop, no coordinator), or the `linear` pipeline was given `pipeline.config.activation: auto` (equivalently `new AutoActivation()` in the builder). `AutoActivation` requires either subagents in the registry OR the active skill to declare `steps:` in its frontmatter. With neither, the pipeline keeps `tool-loop`.

**Fix.**
- Confirm `pipeline.name` is set to a coordinator-bearing pipeline (`linear`, `dag`, or `stepper`) — `flat` (the default) never coordinates.
- For `linear`, remove the `pipeline.config.activation` field — the default is `explicit` and always activates once the linear pipeline is selected.
- Or confirm `subagents:` is non-empty (`grep subagent_built smart-server.log` should show one per agent on startup).
- Or wire in a skill with explicit `steps:` to satisfy `AutoActivation`.

`AutoActivation` remains useful for mixed-traffic agents that should gracefully fall back to `tool-loop` when nothing to coordinate — it is not the default any more.

---

### Startup fails with a legacy-config migration error

**Symptom.** The server aborts at startup (before serving any request) with a fail-loud migration error complaining about a `coordinator:` block or legacy `pipeline:` overrides (`mcp` / `rag` / `stages` / `llm` under `pipeline:`).

**Cause.** As of v19 the old `coordinator: { mode | planner | planning | dispatch | activation | ... }` YAML block and the legacy `pipeline: { mcp | rag | stages | llm }` overrides were removed in a clean break. The loader throws instead of silently ignoring them.

**Fix.** Migrate the config to the new `pipeline: { name, config }` envelope (top-level `llm:` / `mcp:` / `rag:` / `subagents:` are unchanged):

- `coordinator: { mode: deep-stepper, knowledgeSeed, maxParallelSteps, maxDepth, ... }` → `pipeline: { name: stepper, config: { mode, knowledgeSeed, maxParallelSteps, maxDepth, ... } }`
- `coordinator: { planner, reviewer, finalizer, errorStrategy, ... }` → `pipeline: { name: dag, config: { planner, reviewer, ... } }`
- `coordinator: { planning, dispatch, activation, plannerLlm, maxSteps, ... }` → `pipeline: { name: linear, config: { planning, dispatch, activation, ... } }`

The `config:` keys are the SAME keys the old `coordinator:` block used. Load a custom pipeline via `plugins: ['@scope/my-pipeline']`. If you cannot migrate yet, pin a version ≤ 18.

---

### Final response has step blocks but token usage shows 0

**Symptom.** The HTTP response content contains `### step-1`, `### step-2`, etc. with real subagent output, but `usage.prompt_tokens`, `usage.completion_tokens`, and `usage.total_tokens` are all 0.

**Cause.** Each subagent's `process()` runs in its own session and emits its own usage to its own logs. The Coordinator captures `StepResult.usage` per step but does not aggregate it into the parent's final HTTP `usage` field.

**Fix.** This is a known gap tracked in PR #129 follow-ups. Per-step token usage is observable via subagent-level session logs or tracer spans. HTTP-level aggregation is a planned future enhancement. Do not rely on the top-level `usage` field for cost accounting on Coordinator requests.

---

### `coordinator_step_*` events not in smart-server.log

**Symptom.** `subagent_built` and `coordinator_configured` events appear in `smart-server.log`, but `coordinator_plan`, `coordinator_step_start`, and `coordinator_step_done` do not — even though the response clearly shows multi-step output.

**Cause.** `CoordinatorHandler` emits these events via `ctx.options?.sessionLogger?.logStep(...)`. The smart-server's file-logger sink filters to higher-level `event:`-tagged entries and does not always include stage-level `logStep` calls.

**Fix.** This is an observability gap tracked in PR #129 follow-ups. Confirm coordinator execution by inspecting the response content directly (look for `### step-N` blocks). To get structured span data, enable tracer spans in your YAML (`tracer: { enable: true }`) if your build supports it.

---

### `planning: skill-steps` returns "step has no agent" on first step

**Symptom.** Response shows `### step-1` block but `ok: false, error: "SubAgentDispatch: step 'step-1' has no agent..."`. Subsequent steps may also fail. Plan source in logs is `skill-steps`.

**Cause.** Skill steps don't declare `agent:` in their frontmatter, and `dispatch` is pinned to `subagent` (or you wired `new SubAgentDispatch()` manually).

**Fix.**
- Easiest: drop the explicit `dispatch:` from YAML — when `planning: skill-steps`, the loader defaults to `hybrid` which falls back to `SelfDispatch` for un-routed steps.
- Or: add `agent: <name>` to each `steps[]` entry in the skill's frontmatter and keep `dispatch: subagent`.
- Programmatic: use `new HybridDispatch(new SubAgentDispatch(), new SelfDispatch(mainLlm))` instead of bare `new SubAgentDispatch()`.

---

## When in doubt

- `smart-server.log` — every chat request, every tool-loop iteration with `toolCount` and a content summary.
- `curl http://localhost:6333/collections/<name>` — for Qdrant collection state.
- `gh issue list --state open` and `gh pr list` — for ongoing fixes.
