# Deployment Guide

This guide covers production deployment patterns for the SmartAgent monorepo (`@mcp-abap-adt/llm-agent-libs` + binary `@mcp-abap-adt/llm-agent-server`), including containerization, process management, serverless patterns, scaling strategies, and operational best practices.

## Quick Start

```bash
# 1. Install
npm install -g @mcp-abap-adt/llm-agent-server

# 2. Generate config — the first run with no config writes a template and exits
npx llm-agent   # creates smart-server.yaml with defaults, then exits

# 3. Set environment variables
#    Place all credentials in a single .env file at the project root.
#    The launcher scripts auto-select the pipeline based on LLM_PROVIDER.
#    Separate pipeline configs are available per provider:
#      pipelines/deepseek.yaml      — DeepSeek
#      pipelines/sap-ai-core.yaml   — SAP AI Core
#    Use --config to select a pipeline explicitly:
npx llm-agent --config pipelines/deepseek.yaml

# 4. Or start with the default config
npx llm-agent
```

The server listens on `http://0.0.0.0:4004` by default and exposes the following inbound API endpoints:

- **OpenAI Chat Completions** — `POST /v1/chat/completions` — for Cline, Goose, and OpenAI-compatible clients
- **Anthropic Messages API** — `POST /v1/messages` — for Claude CLI (Claude Code) and the Anthropic SDK
- **Model list** — `GET /v1/models` — returns all models available from the configured provider; append `?exclude_embedding=true` to filter out embedding models
- **Embedding models** — `GET /v1/embedding-models` — returns only embedding models; for SAP AI Core this uses capabilities metadata for reliable filtering

Both chat endpoints route through the same SmartAgent pipeline. See [CLIENT_SETUP.md](CLIENT_SETUP.md) for client-specific connection instructions.

## Docker

> **Redistribution note.** An image that installs these packages redistributes
> them, so ship the notices with it: state that the product uses these libraries
> under the LGPL and, if the image installs `llm-agent-server`, that binary under
> the GPL. Include the licence texts — `LICENSE` plus `GPL-3.0.txt` in each
> library package, `LICENSE` in the server package — all of which already sit
> under `node_modules/@mcp-abap-adt/<pkg>/`, so a normal `npm ci` image carries
> them; just don't strip them. You do **not** owe anyone your own source for
> merely installing and running the packages unmodified — including running the
> server, since the GPL has no network trigger. See [LICENSING.md](LICENSING.md).

### Dockerfile (multi-stage)

```dockerfile
# ---- Build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Production stage ----
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY smart-server.yaml ./

EXPOSE 4004
CMD ["node", "dist/smart-agent/cli.js"]
```

### docker-compose.yml

```yaml
version: "3.9"

services:
  llm-agent:
    build: .
    ports:
      - "4004:4004"
    environment:
      - LLM_API_KEY=${LLM_API_KEY}
    volumes:
      - ./smart-server.yaml:/app/smart-server.yaml:ro
    depends_on:
      - qdrant
      - ollama
    restart: on-failure

  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
    volumes:
      - qdrant-data:/qdrant/storage

  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama

volumes:
  qdrant-data:
  ollama-data:
```

### Environment variable injection

`smart-server.yaml` supports `${VAR}` syntax for environment variable interpolation:

```yaml
llm:
  model: ${LLM_MODEL:-deepseek-chat}
  # credentialRef omitted: reads LLM_API_KEY

rag:
  store:
    type: qdrant
    url: ${QDRANT_URL:-http://qdrant:6333}
```

Secrets are never substituted into the config: the server reads `LLM_API_KEY` (or the variables of
the ref an entry names). `${VAR}` still works for non-secret settings such as URLs and model names.
Variables are resolved at startup by `resolveEnvVars()` in `packages/llm-agent-server-libs/src/smart-agent/yaml-loader.ts` (re-exported from `.../config.ts`).

## systemd

### Unit file (`/etc/systemd/system/llm-agent.service`)

```ini
[Unit]
Description=LLM Agent Smart Server
After=network.target

[Service]
Type=simple
User=llm-agent
WorkingDirectory=/opt/llm-agent
ExecStart=/usr/bin/node dist/smart-agent/cli.js
Restart=on-failure
RestartSec=5

# Environment
EnvironmentFile=/opt/llm-agent/.env

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=llm-agent

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/llm-agent/sessions

[Install]
WantedBy=multi-user.target
```

### Log rotation

With `journald` integration, logs are managed automatically. To query:

```bash
journalctl -u llm-agent -f          # Follow live logs
journalctl -u llm-agent --since today  # Today's logs
```

For file-based logging (when `log:` is set in `smart-server.yaml`), use `logrotate`:

```
/opt/llm-agent/smart-server.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
}
```

## Cloud Functions / Serverless

For serverless environments, use `SmartAgent` programmatically without the HTTP layer:

```ts
import { SmartAgentBuilder, LlmAdapter, LlmProviderBridge } from '@mcp-abap-adt/llm-agent-libs';
import { DeepSeekProvider } from '@mcp-abap-adt/deepseek-llm';
import { InMemoryRag, staticApiKey } from '@mcp-abap-adt/llm-agent';

// Build once per cold start (or pool across invocations)
const provider = new DeepSeekProvider({
  credential: staticApiKey(process.env.DEEPSEEK_API_KEY!),
  model: 'deepseek-chat',
});
const handle = await new SmartAgentBuilder()
  .withMainLlm(new LlmAdapter(new LlmProviderBridge(provider), { model: provider.model }))
  .setToolsRag(new InMemoryRag())
  .build();

// Stateless invocation
export async function handler(event: { message: string }) {
  const result = await handle.agent.process(event.message);
  return { body: result.content };
}
```

**Key considerations:**

- Use `in-memory` RAG for stateless functions (or external Qdrant for shared state).
- Build the agent once during cold start and reuse across invocations.
- Call `handle.close()` in a shutdown hook to release MCP connections.
- For AWS Lambda, set `rag.type: 'qdrant'` with an external Qdrant instance to persist knowledge across invocations.

## Scaling

### Horizontal scaling

SmartServer is stateless by default — place multiple instances behind a load balancer:

```
                ┌──────────────┐
                │ Load Balancer│
                └──┬───┬───┬──┘
                   │   │   │
            ┌──────┘   │   └──────┐
            ▼          ▼          ▼
       ┌─────────┐┌─────────┐┌─────────┐
       │ Server 1││ Server 2││ Server 3│
       └────┬────┘└────┬────┘└────┬────┘
            │          │          │
            └──────┬───┘──────────┘
                   ▼
            ┌─────────────┐
            │   Qdrant    │
            │ (shared)    │
            └─────────────┘
```

### Session affinity

- **InMemoryRag** is per-process — if using it, enable sticky sessions on the load balancer.
- **Qdrant** or other external RAG stores provide shared state across instances — no affinity needed.
- **MCP connections** are isolated per session by default (v20.6.0+): concurrent tool-using requests each get their own upstream MCP connection, so a single instance handles concurrency safely without responses crossing. If your upstream MCP server caps connections, set `agent.mcpSharedClient: true` and cap concurrency accordingly (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#concurrent-tool-using-requests-cross-responses-one-balloons-one-returns-no-response)).

### External RAG for shared state

Configure Qdrant for multi-instance deployments:

```yaml
rag:
  store:
    type: qdrant
    url: http://qdrant.internal:6333
    collectionName: llm-agent-production
    credentialRef: QDRANT       # the server reads QDRANT_API_KEY
  embedder:
    provider: openai
    model: text-embedding-3-small
    # Optional. Texts per embedBatch call: this → the provider's declared cap →
    # 100. Set it only when the tenant's quota is stricter than the model's
    # documented limit; exceeding a hard cap is a 400, not a slowdown.
    # maxBatchSize: 250
```

`dedupThreshold` is not shown here: it is read only by the `in-memory` store, not Qdrant.

All instances share the same vector store, ensuring consistent tool discovery and knowledge retrieval.

## Monitoring

### Health endpoint

SmartServer exposes `GET /health` (aliased as `GET /v1/health`) returning structured diagnostics:

```bash
curl http://localhost:4004/health
```

```json
{
  "status": "healthy",
  "uptime": 3600000,
  "version": "21.0.0",
  "timestamp": "2026-07-16T10:00:00.000Z",
  "components": {
    "llm": true,
    "rag": true,
    "mcp": [
      { "name": "http://localhost:3000/mcp", "ok": true },
      { "name": "http://localhost:3001/mcp", "ok": false, "error": "ECONNREFUSED" }
    ],
    "toolCatalog": {
      "vectorized": 356,
      "total": 356,
      "complete": true,
      "clientFailures": 0
    }
  },
  "ready": true
}
```

**Status codes:**

| Condition | HTTP code | Meaning |
|---|---|---|
| `ready === true` | `200` | Server is ready; `status` may still be `degraded` (e.g. soft LLM/RAG failure) — clients can proceed |
| `ready === false` | `503` | MCP is not connected yet (readiness gate); clients should retry |

- `ready` is `false` while the configured MCP connection strategy has not yet connected. With a YAML `mcp:` block the default is a resilient reconnecting strategy (`PeriodicConnectionStrategy`), so `ready` starts `false` and flips to `true` once MCP connects. (A consumer-injected `NoopConnectionStrategy` reports ready immediately and never gates.)
- `status: 'degraded'` means a soft signal — LLM or RAG probe failure, an open circuit breaker, or an incomplete MCP tool catalog — while the server is still serving. A `200` with `status: 'degraded'` is normal under transient provider issues.
- `components.mcp` is an array — one entry per configured MCP server — with `ok: boolean` and an optional `error` string.
- `components.toolCatalog` reports startup tool vectorization and is **absent** when none ran (no tools store, or a read-only one). `complete: false` ⇒ `degraded`. Read `complete`, not `vectorized === total`: a client whose `tools/list` failed contributes to neither counter, so the counters alone would look like a full catalog — `clientFailures` is what exposes it. The full list of failed tool names is deliberately not in this payload (it is polled on a hot path); read it from the agent's `getToolCatalogStatus()`.

- `circuitBreakers` (present when `circuitBreaker:` is configured) is an array of `{ index, state }`, one entry per breaker and no labels: first one breaker per `llm:` key (shared by every session and role; a `PUT /v1/config` swap of a key gets a fresh one), then the embedder breaker. Any `open` breaker makes `status` `degraded`. A client disconnect is logged as `request_cancelled` and never counts as a breaker failure.
- A `config_warning` at startup such as `rag.retrieval.<key> names no store; known stores: …` means a `rag.retrieval` key matches no store (usually a typo).

Use the `200`/`503` split for Kubernetes readiness probes; use `status` for alerting dashboards.

### Prometheus metrics

Export metrics via `InMemoryMetrics.snapshot()`:

```ts
import { InMemoryMetrics } from '@mcp-abap-adt/llm-agent-libs';

const metrics = new InMemoryMetrics();
// Wire into SmartAgentBuilder via .withMetrics(metrics)

// Expose for Prometheus scraping
app.get('/metrics', (req, res) => {
  const snapshot = metrics.snapshot();
  // Convert snapshot to Prometheus text format
  res.type('text/plain').send(formatPrometheus(snapshot));
});
```

Available metrics: `requestCount`, `requestLatency`, `toolCallCount`, `ragQueryCount`, `classifierIntentCount`, `llmCallCount`, `llmCallLatency`, `circuitBreakerTransition`, `toolCacheHitCount`.

### OpenTelemetry tracing

Install the optional peer dependency and use the OTEL adapter:

```bash
npm install @opentelemetry/api
```

```ts
import { OtelTracerAdapter } from '@mcp-abap-adt/llm-agent-libs/otel';

const tracer = new OtelTracerAdapter();
// Wire into SmartAgentBuilder via .withTracer(tracer)
```

Spans are emitted for: classification, RAG query, context assembly, LLM chat, tool execution, and reranking.
A failed rerank of a store with a `rag.retrieval` strategy logs the session step `retrieval_rerank_error` (`store`, `strategy`, `code`, `message` — for a decision reranker `decision rerank failed: <DECISION_CODE>: <message>`) and keeps the embedding order; a failed global (plugin / `withReranker`) rerank sets the span attribute `<store>.rerank_error` (always the code `RERANK_ERROR`) and logs a `rerank_error` session step whose `message` reads `decision rerank failed: <DECISION_CODE>: <message>` for a decision reranker.

### Session debug logs

Enable per-session debug logging:

```yaml
logDir: sessions  # Directory for detailed session debug logs
```

Each session writes a structured JSON log with every pipeline step, useful for debugging individual request flows.

## Backup & Recovery

### Qdrant collection snapshots

```bash
# Create snapshot
curl -X POST http://qdrant:6333/collections/llm-agent/snapshots

# List snapshots
curl http://qdrant:6333/collections/llm-agent/snapshots

# Restore from snapshot
curl -X PUT http://qdrant:6333/collections/llm-agent/snapshots/recover \
  -H 'Content-Type: application/json' \
  -d '{"location": "file:///qdrant/snapshots/snapshot-2024-01-01.snapshot"}'
```

### Config versioning

Keep `smart-server.yaml` under version control. The `ConfigWatcher` supports hot-reload — changes to weights, thresholds, and logging levels are applied without restart:

```yaml
# These values are hot-reloadable (no restart needed). vectorWeight/keywordWeight
# are read from rag.store, and only for the in-memory store type:
rag:
  store:
    vectorWeight: 0.7
    keywordWeight: 0.3
agent:
  ragQueryK: 10
  historyAutoSummarizeLimit: 10
```

## Per-store reranking (`rag.retrieval`)

A store with `strategy: rerank` / `rerank-all` and `reranker: decision` sends the user query and its retrieved
candidates to TypeSafe's API: one request per query, split only when the candidates exceed the batch budget.
Only stores with such an entry are sent: `tools` (MCP tool descriptions; queried once per request in the flat
pipeline and once per step on the controller), a knowledge collection, or `history` (which may include earlier
assistant answers derived from back-end tool output). A store with `strategy: embedding`, or no entry, is not
sent by this mechanism; a plugin / `withReranker` reranker still reranks the stores without an entry (see
[SECURITY_THREAT_MODEL.md](SECURITY_THREAT_MODEL.md), AS-7). Reranked scores replace the cosine scores, so a
`threshold` tool-selection strategy (`agent.toolSelection.minScore`) compares against probabilities in
`[0, 1]` when `tools` is reranked (see [PERFORMANCE.md](PERFORMANCE.md#tool-selection-semantic-distance)).
Size the network egress and the provider quota (`decision.timeoutMs`, `decision.maxRetries`) accordingly. The
key is `DECISION_API_KEY` (or `<REF>_API_KEY` with `decision.credentialRef`) in the server's environment.
`rag.retrieval` is server-wide: a worker (subagent) config that declares it is rejected at startup. `decision:`
and `rag.retrieval` are not hot-reloadable; a change takes a restart. A `reranker: llm` entry keeps the LLM instance resolved at startup: a `PUT /v1/config` swap of the model behind its key (`main`, `classifier` or `helper`) reaches the agents but not that reranker; restart to rerank with the new model. The chat and adapter routes abort the request when the client disconnects before the response finished, and the reranker receives that `signal`; otherwise a slow reranker call is cut off only by the provider's own
timeout (`decision.timeoutMs`).

## Security Checklist

- **API key management** — Use environment variables or secret managers (AWS Secrets Manager, Vault). Configs hold `credentialRef` names only; a secret never enters a loaded config, so there is no YAML literal to store in a committed file.
- **Network binding** — Bind to `127.0.0.1` for local-only access. Use a reverse proxy (nginx, Caddy) for public exposure with TLS termination.
- **MCP transport security** — Use TLS (`https://`) for remote MCP HTTP endpoints. For local MCP stdio servers, ensure the spawned process is trusted.
- **Third-party data egress** — a `rag.retrieval` entry with `reranker: decision` (or a global plugin reranker) sends the user query and retrieved passages to an external model (see [SECURITY_THREAT_MODEL.md](SECURITY_THREAT_MODEL.md), AS-7). Enable it only where that is acceptable.
- **Rate limiting** — Add rate limiting at the reverse proxy layer. SmartServer does not implement rate limiting internally.
- **Input validation** — The `externalToolsValidationMode` config (`strict` vs `permissive`) controls how strictly tool arguments are validated against schemas.
- **Prompt injection** — Wire an `IPromptInjectionDetector` via the builder for tool-result inspection. The library ships a `HeuristicInjectionDetector`.
- **CORS** — SmartServer does not set CORS headers. Configure at the reverse proxy level for browser clients.
