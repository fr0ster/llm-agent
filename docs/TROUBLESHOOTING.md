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

### MCP server unreachable at startup

**Symptom.** Server starts cleanly with `event: server_started`, tool-using requests return "I don't have that tool", and `/health` shows `components.mcp[].ok: false`.

**Cause.** The MCP server was not reachable when the connection strategy resolved at startup. When an `mcp:` block is configured, the default is a resilient `PeriodicConnectionStrategy` (connect + periodic reconnect + readiness), so the server returns `HTTP 503` (`ready: false` in `/health`) until the MCP connection succeeds, then serves normally. (A consumer that instead injects a `NoopConnectionStrategy` via the builder starts with an empty tool catalog and proceeds without tools.)

**Fix.**

1. Confirm the MCP endpoint is reachable: `curl <mcp-url>` from inside the container or on the same network.
2. The default strategy already reconnects automatically (~10 s interval) — just bring the endpoint up; `/health` flips to `ready: true` and requests start succeeding. There is **no YAML `strategy` key**; to change the strategy in embedded use, inject an `IMcpConnectionStrategy` via `SmartAgentBuilder.withMcpConnectionStrategy(...)`.
3. Check `/health` → `components.mcp` for the per-server `ok`/`error` fields to pinpoint which endpoint is failing.

---

### MCP server goes offline mid-run and the agent returns `(no response)`

**Symptom.** An MCP-tool-using request returns `(no response)` with zero tokens after the MCP server drops mid-run.

**Cause.** Before v20.4.0 a mid-run MCP failure could be swallowed silently. Since v20.4.0 (#223) the consumer-swappable `IMcpFailureClassifier` decides whether a tool error is transient (`tool-error`) or means the server is down (`unavailable`). The default classifier inspects the error object; when `unavailable`, the run fails loud with a descriptive error instead of returning empty output.

**Fix.** Upgrade to `>=20.4.0`. If you need custom classification (e.g. treat all errors as transient), inject a custom `IMcpFailureClassifier`:

```ts
import type { IMcpFailureClassifier } from '@mcp-abap-adt/llm-agent';

class AlwaysToolErrorClassifier implements IMcpFailureClassifier {
  async classify(_error: unknown): Promise<'unavailable' | 'tool-error'> {
    return 'tool-error';  // never treat as unavailable; let executor handle it
  }
}

// Inject via BuildAgentDeps / ControllerSkillPipelineBuilder.build(deps):
//   deps.mcpFailureClassifier = new AlwaysToolErrorClassifier()
```

The default classifier (`IMcpFailureClassifier`) is defined in `packages/llm-agent/src/interfaces/mcp-failure-classifier.ts`. Pass `probeHealth` to it for active connection probing beyond error-code inspection.

---

## Coordinator / multi-agent orchestration

### Response body is "(no response)" and usage tokens are all zero

**Symptom.** HTTP response `choices[0].message.content` is literally `"(no response)"` (or empty); `prompt_tokens`, `completion_tokens`, and `total_tokens` are all 0; `request_done ok:true` appears in `smart-server.log` after ~50–100 ms; no `coordinator_plan` or `coordinator_step_*` events appear between `request_start` and `request_done`.

**Cause.** The Coordinator stage ran, found `ctx.subAgents` undefined (the subagent registry was not propagated to the runtime `PipelineContext`), set `ctx.error`, and returned `false`. The pipeline aborted silently because the executor does not escalate failed-stage errors as stream chunks.

**Fix.** Ensure you are running version 12.0.6 or later — PR #129 includes the `_buildContext` fix. If you are on a fork, verify that `DefaultPipeline._buildContext()` assigns `ctx.subAgents = this.subAgents`.

---

### Concurrent tool-using requests cross responses (one balloons, one returns `(no response)`)

**Symptom.** Two or more MCP-tool-using requests sent concurrently (distinct sessions — e.g. cookieless clients) interfere: one response absorbs both conversations' tool results and balloons in token count, while the other returns `(no response)` with near-zero tokens. Sequential requests are always correct; only concurrency triggers it.

**Cause.** Before v20.6.0, every session shared **one** global MCP client by reference (the same failure class as the LLM `keepAlive` issue #219, but for the MCP client). Concurrent `callTool` invocations on the single shared connection interleave and their responses cross.

**Fix.** Upgrade to **v20.6.0 or later** — the server now gives each session its own MCP client for tool execution by default (`agent.mcpSharedClient: false`). If you deliberately need the old shared-connection behavior (e.g. an upstream MCP server that permits only one connection), set `agent.mcpSharedClient: true` and serialize concurrent traffic upstream. Isolation applies only to the server-owned YAML `mcp:` path; injected clients / a `connectMcp` seam stay shared by design (they are the consumer's single provisioning point).

---

### A tool error (locked object) makes the controller loop, balloon, or return `(no response)`

**Symptom.** A request that hits a tool-level failure — most often a locked or concurrently-edited SAP object — does not fail cleanly. Instead the controller retries the same failing call many times: the request balloons in token count (up to hundreds of thousands of tokens on a many-tool deployment), or hangs until the timeout and returns `(no response)`. In the worst case a failed create/activate is reported as "completed successfully" while the object is left inactive.

**Cause.** Before v20.7.0 the MCP tool-result `isError` flag was dropped between the wire and the controller (the client wrapper and adapter read only the JSON-RPC error, not the tool result's own `isError`), so the controller recorded every failed call as a delivered success. The executor never saw the failure and retried it indefinitely. (This assumes the MCP tool actually signals the failure structurally with `isError: true`; a tool that returns a lock error as plain text with a false `success: true` must be fixed on the tool side first.)

**Fix.** Upgrade to **v20.7.0 or later**. `isError` is now threaded end to end across all transports (including `embedded`), and the controller cuts the step on the first failed tool round: the planner then either replans (if the failure is in something it chose) or surfaces the real tool error to the consumer (if the request pinned the failing constraint) — never `(no response)`. No configuration is required. If you run a flat (planner-less) pipeline and need the final answer to *deterministically* report the failure, plug in an `IOutputValidator` that rejects a success answer when a tool round failed.

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

**v20 addition — `planner:` key rejected inside controller config.** If your controller YAML contains a `planner:` sub-key under `pipeline.config`, the server fails loud:

```
ConfigValidationError: pipeline.config.planner is not a valid controller config key.
Use pipeline.name: "controller" (smart-executor) or "controller-weak" (weak-executor).
```

**Fix.** Remove `pipeline.config.planner` and select the pairing via the pipeline name:
- `pipeline: { name: controller }` → smart-executor (coarse steps, capable executor self-expands)
- `pipeline: { name: controller-weak }` → weak-executor (one action per step, for smaller models)

`subagents.planner` / `flow.planner` remain valid; only the top-level `config.planner` key is removed.

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

### Controller `wait` step surfaces as a client-side timeout, not a completed plan

**Symptom.** A controller-pipeline request that the planner scheduled with a `wait` step (e.g. "activate X, wait, then read X") hangs and then fails at the client/proxy/load-balancer with a generic timeout error, instead of returning a finished plan.

**Cause.** A `wait` step is served synchronously by the controller — it blocks the request for `min(waitMs, maxWaitMs, remaining maxTotalWaitMs)` milliseconds before the next step runs (see `packages/llm-agent-server-libs/src/smart-agent/controller/wait-step.ts`). If the effective wait — or the sum of waits in a plan, once you add later steps' processing time — exceeds the deployment's own request timeout (HTTP client, reverse proxy, load balancer, gateway), that outer layer aborts the connection first. The controller never gets a chance to finish; the client sees a bare timeout, not the actual plan result.

**Fix.** Whenever you raise `pipeline.controller.maxWaitMs` / `maxTotalWaitMs` (or the planner emits a plan with a long wait), raise the client/proxy/load-balancer request timeout together with it — the knob and the surrounding infrastructure timeout MUST move in lockstep. Also note: a client disconnect (e.g. the caller gives up and closes the connection) does not currently cancel an in-flight wait — the controller keeps sleeping and completes the step server-side regardless of whether anyone is still listening.

---

## Debug tracing

**Symptom.** You need to see exactly what was sent to/from the LLM, which controller
decisions were made, what MCP tool calls did, or what a RAG recall returned — beyond
what `smart-server.log` captures.

**Fix.** Enable one or more area flags (all off by default):

```bash
DEBUG_LLM=1         # capture LLM request+response on the inference paths (flat agent loop, tool-loop, pass-through, controller subagents)
DEBUG_CONTROLLER=1  # controller step decisions (also prints to stderr)
DEBUG_MCP=1         # MCP tool call args/result/timing
DEBUG_RAG=1         # RAG recall queries + returned extracts
DEBUG_TRACE_DIR=./.smart-agent-debug/   # optional, this is the default
```

Each enabled area writes per-step JSON files under `DEBUG_TRACE_DIR`, one subdirectory
per session/request (e.g. `.smart-agent-debug/session_<id>/req_<id>/`). Areas are
independent — enabling `DEBUG_LLM` alone produces only `*_llm_request_*` /
`*_llm_response_*` files, no controller/MCP/RAG files.

**Note.** A trace may contain your own prompt/business data (and, for MCP/RAG areas,
tool arguments or retrieved document text). Review trace files before sharing them
outside your team.

---

## When in doubt

- `smart-server.log` — every chat request, every tool-loop iteration with `toolCount` and a content summary.
- `curl http://localhost:6333/collections/<name>` — for Qdrant collection state.
- `gh issue list --state open` and `gh pr list` — for ongoing fixes.
