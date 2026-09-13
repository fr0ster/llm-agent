# SAP AI Core Integration

## Overview

SAP AI Core is a managed AI platform within the SAP Business Technology Platform (BTP) that provides centralized access to multiple LLM providers (OpenAI, Anthropic, DeepSeek, and others) through a single API. Instead of connecting directly to each provider, requests are routed through SAP AI Core, which handles authentication, rate limiting, quotas, and governance.

Key differences from direct provider access:

- **Single authentication**: OAuth2 Client Credentials via SAP AI Core service key instead of per-provider API keys.
- **Unified endpoint**: One SAP AI Core URL replaces multiple provider base URLs.
- **Governance**: Centralized usage tracking, content filtering, and audit logs within BTP.
- **Model abstraction**: Switch between models (GPT-4o, Claude 3.5, DeepSeek) by changing a config value, without changing credentials.

## Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────────────────┐
│              │     │                     │     │                          │
│  Consumer    │────▶│  SmartAgent         │     │  SAP AI Core (BTP)       │
│  (your app)  │     │  (SmartAgentBuilder)│     │                          │
│              │     │                     │     │  ┌──────────────────┐    │
│              │     │  ┌─────────────────┐│     │  │ Orchestration    │    │
│              │     │  │ convertTools    ││     │  │ Service          │    │
│              │     │  │ MCP → OpenAI fn ││     │  └────────┬─────────┘    │
│              │     │  └────────┬────────┘│     │           │              │
│              │     │           │         │     │           │              │
│              │     │  ┌────────▼────────┐│     │  ┌────────▼─────────┐    │
│              │     │  │SapCoreAIProvider││────▶│  │OrchestrationAPI  │    │
│              │     │  │                 ││     │  └────────┬─────────┘    │
│              │     │  │  Orchestration  ││     │           │              │
│              │     │  │  Client (SDK)   ││     │  ┌────────▼─────────┐    │
│              │     │  └─────────────────┘│     │  │  External LLM    │    │
│              │     └─────────────────────┘     │  │  (GPT-4o, Claude,│    │
│              │                                 │  │   DeepSeek, etc.) │    │
│              │◀────────── response ────────────│  └──────────────────┘    │
└──────────────┘                                 └──────────────────────────┘
```

## Authentication

SAP AI Core supports two authentication methods:

### 1. Environment Variable (AICORE_SERVICE_KEY)

The simplest approach. Set the `AICORE_SERVICE_KEY` environment variable with the full service key JSON from your BTP cockpit:

```bash
export AICORE_SERVICE_KEY='{"clientid":"sb-xxx","clientsecret":"...","url":"https://api.ai.xxx.aicore.cfapps.xxx.hana.ondemand.com","serviceurls":{"AI_API_URL":"..."},"appname":"...","identityzone":"...","identityzoneid":"...","tenantid":"...","uaa":{"clientid":"...","clientsecret":"...","url":"https://xxx.authentication.xxx.hana.ondemand.com","identityzone":"...","tenantid":"...","tenantmode":"...","sburl":"...","apiurl":"...","verificationkey":"...","xsappname":"...","subaccountid":"...","uaadomain":"...","zoneid":"...","credential-type":"..."}}'
```

The `@sap-ai-sdk/orchestration` package reads this variable automatically. No additional configuration is needed.

### 2. Programmatic Credentials (SapAICoreCredentials)

For environments where you cannot set environment variables (e.g., multi-tenant apps, serverless functions), pass credentials programmatically:

```typescript
import { SapCoreAIProvider, type SapAICoreCredentials } from '@mcp-abap-adt/sap-aicore-llm';

const credentials: SapAICoreCredentials = {
  clientId: 'sb-xxx...',
  clientSecret: 'your-client-secret',
  tokenServiceUrl: 'https://xxx.authentication.xxx.hana.ondemand.com/oauth/token',
  servicUrl: 'https://api.ai.xxx.aicore.cfapps.xxx.hana.ondemand.com',
};

const provider = new SapCoreAIProvider({
  model: 'gpt-4o',
  credentials,
});
```

When `credentials` is provided, the SDK builds an OAuth2ClientCredentials destination object instead of reading `AICORE_SERVICE_KEY`.

## Configuration

### SapCoreAIConfig Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | `string` | **required** | Model name deployed on SAP AI Core (no default — constructor throws if absent) |
| `temperature` | `number` | `0.7` | Generation temperature |
| `maxTokens` | `number` | `16384` | Max tokens for generation |
| `resourceGroup` | `string` | — | SAP AI Core resource group |
| `credentials` | `SapAICoreCredentials` | — | Programmatic OAuth2 credentials (bypasses env var) |
| `apiKey` | `string` | — | Not used by SAP provider (auth handled by SDK) |
| `whenThrottled` | `object` | — | `maxAttempts` and a `strategy`. Omit and nothing waits — see [Throttling](#throttling-429) |
| `log` | `object` | — | Optional logger with `debug()` and `error()`. Throttling is not reported here — see `setThrottleObserver` below, which covers every provider |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `AICORE_SERVICE_KEY` | Full SAP AI Core service key JSON (primary auth method) |
| `LLM_PROVIDER` | Set to `sap-ai-sdk` to use SAP AI Core |
| `SAP_AI_MODEL` | Model name (used by CLI, maps to `model` config) |
| `SAP_AI_RESOURCE_GROUP` | Resource group (used by CLI, maps to `resourceGroup` config) |

## Usage Examples

### CLI Usage

```bash
# Set credentials
export AICORE_SERVICE_KEY='{ ... }'
export LLM_PROVIDER=sap-ai-sdk
export SAP_AI_MODEL=gpt-4o
export SAP_AI_RESOURCE_GROUP=default

# Run
npm run dev
```

### Programmatic Usage — Basic

```typescript
import { SapCoreAIProvider } from '@mcp-abap-adt/sap-aicore-llm';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';

const provider = new SapCoreAIProvider({
  model: 'gpt-4o',
  resourceGroup: 'default',
  maxTokens: 4000,
});

const { agent } = await new SmartAgentBuilder()
  .withMainLlm(provider)
  .build();

const response = await agent.process('What tools are available?');
```

### Programmatic Usage — With Credentials

```typescript
import { SapCoreAIProvider, type SapAICoreCredentials } from '@mcp-abap-adt/sap-aicore-llm';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';

const credentials: SapAICoreCredentials = {
  clientId: 'sb-xxx',
  clientSecret: 'secret',
  tokenServiceUrl: 'https://auth.example.com/oauth/token',
  servicUrl: 'https://api.ai.example.com',
};

const provider = new SapCoreAIProvider({
  model: 'claude-3-5-sonnet',
  resourceGroup: 'default',
  credentials,
  log: console, // optional: log debug/error messages
});

const { agent } = await new SmartAgentBuilder()
  .withMainLlm(provider)
  .build();
```

### Pipeline Configuration (SmartAgent)

When using the SmartAgent pipeline, SAP AI Core is configured through the pipeline config:

```yaml
llm:
  provider: sap-ai-sdk
  model: gpt-4o
  temperature: 0.7
  maxTokens: 4000
  resourceGroup: default
```

## Streaming Diagnostics

SAP AI Core streaming can fail after successful MCP/tool execution but before the final response is fully delivered to the client. In production, if your host sees unstable `sap-ai-sdk` streaming behavior, prefer a non-streaming request path for SAP AI Core and use the streaming path only for diagnosis.

`SapCoreAIProvider` now emits detailed debug/error logs when a `log` object is injected:

- stream start metadata: model, resource group, message count, tool count, max tokens, temperature
- compact message summary: roles, content lengths, tail previews, tool-call markers
- stream lifecycle markers: messages formatted, client created, stream opening, stream opened
- per-chunk diagnostics: chunk index, content length, cumulative emitted content, finish reason, token usage when available
- enriched failure diagnostics: whether the stream opened, how many chunks/content chunks were emitted, SDK cause/code, HTTP status, and response payload when available

When SmartAgent pipeline logging is enabled, the tool-loop also records a compact context snapshot before each LLM iteration. This is especially useful for the final post-tool-call pass because it shows the exact message shape that was sent into the failing SAP AI Core streaming call.

### Recommended Production Policy

- Use non-streaming for `sap-ai-sdk` in production if the final response stream is unstable.
- Keep streaming enabled only in controlled debugging scenarios.
- Collect both provider logs and SmartAgent session-step logs for the same request to correlate:
  - final iteration context
  - stream open event
  - first emitted chunks
  - exact failure boundary

Two ways to disable streaming for SAP AI Core:

**Per-provider** (recommended for multi-model pipelines):
```yaml
pipeline:
  llm:
    main:
      provider: sap-ai-sdk
      model: gpt-4o
      streaming: false
```

**Global** (applies to tool-loop regardless of provider):
```yaml
agent:
  llmCallStrategy: non-streaming
```

## Throttling (429)

SAP AI Core meters requests per minute, per model, per resource group. Over the
limit it answers `429 Too Many Requests` with a `Retry-After` header in seconds.

The provider establishes the facts and **does not decide how long you may be
held**. It reads the status and the interval, records that the quota is shut,
and hands the failure up. Whether to sit out that interval or to tell your own
user depends on who is waiting at the other end, which a library cannot see: a
CLI can happily wait a minute, an HTTP service answering inside a request
cannot.

Two strategies ship. Neither invents a duration.

| Strategy | What it does |
|---|---|
| `ReportThrottling` (default) | Never waits. Returns the failure with what the server said |
| `WaitAsTold` | Waits exactly the interval the server named, and reports when it named none |

```ts
import { WaitAsTold } from '@mcp-abap-adt/llm-agent';

new SapCoreAIProvider({
  model: 'anthropic--claude-4.5-sonnet',
  resourceGroup: 'default',
  whenThrottled: { strategy: new WaitAsTold(), maxAttempts: 3 },
});
```

`maxAttempts` is the only number in the policy, and it is a count rather than a
duration — the one bound that can be set without knowing anything about the
caller. A consumer who wants exponential backoff writes a strategy: that is a
guess about someone else's server, and a guess belongs to whoever owns it.

A caller that wants a deadline already has one — pass an `AbortSignal`. It is
your deadline, from your own clock, rather than a number the library invented.

### What is shared, and what is not

Knowing is shared; waiting is not.

The quota's closing time is recorded in a process-wide gate keyed by account,
endpoint and model, so **a call into a quota already known to be shut is never
sent**. There is nothing to learn from a refusal that can be predicted, and a
refusal we ask for is a refusal we are charged for. The caller gets the failure
immediately, with the interval remaining.

What is not shared is the decision to wait. A gate that held every caller would
impose a delay nobody consented to — the same mistake as a budget, wearing the
word "guarantee".

### Seeing it happen

```ts
import { setThrottleObserver } from '@mcp-abap-adt/llm-agent';

setThrottleObserver((e) => log.warn('throttled', e));
```

One subscription for every provider, fired on every refusal and on every call
turned away at a shut gate. The event carries the quota key, the policy and
strategy in force, the attempt, whether the server named an interval and which,
and why a call is not going on.

Whether the server sends `Retry-After` is worth reading off these events: with
`WaitAsTold` it is the difference between waiting and reporting, and a server
that documents the header but omits it is telling you something.

Read the outcome as a fact, not as a substring of a message:

```ts
import { findThrottled } from '@mcp-abap-adt/llm-agent';

const limit = findThrottled(error);   // undefined when it was not throttling
if (limit) console.warn(limit.attempts, limit.retryAfterSeconds, limit.reason);
```

If throttling persists, the quota itself is too small for the traffic: spread
the load across resource groups, or raise the model's limit in AI Core.

## Tool Format Conversion

MCP tools are converted to OpenAI function format before being sent to SAP AI Core. `SapCoreAIProvider` handles this conversion automatically.

### MCP Tool (input)

```json
{
  "name": "get_weather",
  "description": "Get current weather for a location",
  "inputSchema": {
    "type": "object",
    "properties": {
      "location": { "type": "string", "description": "City name" }
    },
    "required": ["location"]
  }
}
```

### OpenAI Function Format (output, sent to SAP AI Core)

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get current weather for a location",
    "parameters": {
      "type": "object",
      "properties": {
        "location": { "type": "string", "description": "City name" }
      },
      "required": ["location"]
    }
  }
}
```

If a tool is missing `name`, `description`, or `inputSchema`, safe defaults are used:
- `name` → `''`
- `description` → `''`
- `inputSchema` → `{ "type": "object", "properties": {} }`

## Model Discovery

### getModels()

`getModels()` now returns **all models** available in the configured resource group, including both text-generation and embedding models. Previously it was filtered to text-generation only.

If you need the old behaviour (text-generation models only), use the `?exclude_embedding=true` query parameter on the `/v1/models` endpoint:

```bash
# All models (new default)
curl http://localhost:4004/v1/models

# Text-generation models only (previous behaviour)
curl http://localhost:4004/v1/models?exclude_embedding=true
```

### GET /v1/embedding-models

A dedicated endpoint that reliably returns only embedding models for SAP AI Core. Unlike `/v1/models`, this endpoint uses the capabilities metadata from SAP AI Core to filter models — avoiding heuristics based on model name patterns.

```bash
curl http://localhost:4004/v1/embedding-models
```

Use this endpoint to dynamically discover which embedding model names are valid when configuring the `EMBEDDING_MODEL` variable or the `rag.embedder.model` field in `smart-server.yaml`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `AICORE_SERVICE_KEY is not set` | Missing env var | Export the service key JSON |
| `401 Unauthorized` | Invalid or expired credentials | Regenerate service key in BTP cockpit |
| `Model not found` | Model not deployed | Deploy the model in SAP AI Core Launchpad |
| `Resource group not found` | Wrong resource group | Check `SAP_AI_RESOURCE_GROUP` value |
| `OAuth2 token error` | Wrong `tokenServiceUrl` | Verify the URL from service key `uaa.url` |
| `429 Too Many Requests` surviving the retries | Sustained throttling — the per-minute quota for that model is smaller than the traffic | The error carries `throttled` and `retryAfterSeconds`; see [Throttling](#throttling-429). Spread load across resource groups or raise the model's limit |
| `400 "Either a prompt template or messages must be defined"` | SDK requires `prompt.template` | Fixed in v2.9.0 — upgrade the package |
| `400 "Unused parameters"` | Using `messagesHistory` instead of `messages` | Fixed in v2.9.0 — upgrade the package |
| `Stream finished with token length exceeded` | `maxTokens` too low for tool-calling models | Set `maxTokens: 32768` or higher in config |
| `SAP AI SDK streaming error` after successful tool calls | AI Core SSE path is unstable or fails on the final post-tool-call response | Switch SAP AI Core traffic to non-streaming for production, then inspect provider debug logs and SmartAgent iteration context logs |
