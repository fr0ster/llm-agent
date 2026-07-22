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
      - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
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
  apiKey: ${DEEPSEEK_API_KEY}
  model: ${LLM_MODEL:-deepseek-chat}

rag:
  type: qdrant
  url: ${QDRANT_URL:-http://qdrant:6333}
```

Variables are resolved at startup by `resolveEnvVars()` in `packages/llm-agent-server/src/smart-agent/config.ts`.

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
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';

// Build once per cold start (or pool across invocations)
const handle = await new SmartAgentBuilder({
  llm: { apiKey: process.env.DEEPSEEK_API_KEY! },
  rag: { type: 'in-memory' },
}).build();

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
  type: qdrant
  url: http://qdrant.internal:6333
  collectionName: llm-agent-production
  dedupThreshold: 0.92
```

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
  "version": "20.5.0",
  "timestamp": "2026-07-16T10:00:00.000Z",
  "components": {
    "llm": true,
    "rag": true,
    "mcp": [
      { "name": "http://localhost:3000/mcp", "ok": true },
      { "name": "http://localhost:3001/mcp", "ok": false, "error": "ECONNREFUSED" }
    ]
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
- `status: 'degraded'` means LLM or RAG health probes returned soft failures but the server is still serving. A `200` with `status: 'degraded'` is normal under transient provider issues.
- `components.mcp` is an array — one entry per configured MCP server — with `ok: boolean` and an optional `error` string.

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
# These values are hot-reloadable (no restart needed):
rag:
  vectorWeight: 0.7
  keywordWeight: 0.3
agent:
  ragQueryK: 10
  historyAutoSummarizeLimit: 10
```

## Security Checklist

- **API key management** — Use environment variables or secret managers (AWS Secrets Manager, Vault). Never store API keys as YAML literals in committed files.
- **Network binding** — Bind to `127.0.0.1` for local-only access. Use a reverse proxy (nginx, Caddy) for public exposure with TLS termination.
- **MCP transport security** — Use TLS (`https://`) for remote MCP HTTP endpoints. For local MCP stdio servers, ensure the spawned process is trusted.
- **Rate limiting** — Add rate limiting at the reverse proxy layer. SmartServer does not implement rate limiting internally.
- **Input validation** — The `externalToolsValidationMode` config (`strict` vs `permissive`) controls how strictly tool arguments are validated against schemas.
- **Prompt injection** — Wire an `IPromptInjectionDetector` via the builder for tool-result inspection. The library ships a `HeuristicInjectionDetector`.
- **CORS** — SmartServer does not set CORS headers. Configure at the reverse proxy level for browser clients.
