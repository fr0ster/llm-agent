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
│  Consumer    │────▶│  SapCoreAIAgent     │     │  SAP AI Core (BTP)       │
│  (your app)  │     │                     │     │                          │
│              │     │  ┌─────────────────┐│     │  ┌──────────────────┐    │
│              │     │  │ convertTools    ││     │  │ Orchestration    │    │
│              │     │  │ MCP → OpenAI fn ││     │  │ Service          │    │
│              │     │  └────────┬────────┘│     │  └────────┬─────────┘    │
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
import { SapCoreAIProvider, type SapAICoreCredentials } from '@mcp-abap-adt/llm-agent';

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
| `model` | `string` | `'gpt-4o'` | Model name deployed on SAP AI Core |
| `temperature` | `number` | `0.7` | Generation temperature |
| `maxTokens` | `number` | `16384` | Max tokens for generation |
| `resourceGroup` | `string` | — | SAP AI Core resource group |
| `credentials` | `SapAICoreCredentials` | — | Programmatic OAuth2 credentials (bypasses env var) |
| `apiKey` | `string` | — | Not used by SAP provider (auth handled by SDK) |
| `log` | `object` | — | Optional logger with `debug()` and `error()` methods |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `AICORE_SERVICE_KEY` | Full SAP AI Core service key JSON (primary auth method) |
| `LLM_PROVIDER` | Set to `sap-ai-sdk` (Orchestration) or `sap-ai-core-direct` (Direct) |
| `SAP_AI_MODEL` | Model name (used by CLI, maps to `model` config) |
| `SAP_AI_RESOURCE_GROUP` | Resource group (used by CLI, maps to `resourceGroup` config) |

## Direct Provider (sap-ai-core-direct)

Since v5.14.0, an alternative provider bypasses the Orchestration Service and sends OpenAI-compatible HTTP requests directly to SAP AI Core deployment endpoints. This eliminates ~14K phantom tokens per request added by the Orchestration layer.

| Aspect | `sap-ai-sdk` (Orchestration) | `sap-ai-core-direct` (Direct) |
|--------|-------------------------------|-------------------------------|
| SDK | `@sap-ai-sdk/orchestration` | `@sap-ai-sdk/ai-api` + raw HTTP |
| Token overhead | ~14K phantom tokens | Accurate counts |
| Tool calling | Via promptTemplating module | Native OpenAI function calling |
| Content filtering | Built-in | None (consumer responsibility) |

### YAML configuration

```yaml
llm:
  provider: sap-ai-core-direct
  model: gpt-4o
  resourceGroup: default
```

### Programmatic usage

```typescript
import { SapAiCoreDirectProvider } from '@mcp-abap-adt/llm-agent';

const provider = new SapAiCoreDirectProvider({
  model: 'gpt-4o',
  resourceGroup: 'default',
});
```

Authentication uses the same `AICORE_SERVICE_KEY` environment variable. The provider resolves the deployment URL via `@sap-ai-sdk/ai-api` and caches it for the provider lifetime.

**Limitation:** The direct provider sends OpenAI-compatible request format. It works with OpenAI models (gpt-4o, gpt-4.1, etc.) and DeepSeek models deployed on SAP AI Core. **Anthropic models (claude-*) require a different request format** — use `sap-ai-sdk` (Orchestration) provider for Anthropic models, as the Orchestration Service handles format conversion internally.

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
import { SapCoreAIProvider, SapCoreAIAgent } from '@mcp-abap-adt/llm-agent';

const provider = new SapCoreAIProvider({
  model: 'gpt-4o',
  resourceGroup: 'default',
  maxTokens: 4000,
});

const agent = new SapCoreAIAgent({
  mcpClient,          // your MCPClientWrapper instance
  llmProvider: provider,
});

const response = await agent.process('What tools are available?');
```

### Programmatic Usage — With Credentials

```typescript
import { SapCoreAIProvider, SapCoreAIAgent } from '@mcp-abap-adt/llm-agent';

const provider = new SapCoreAIProvider({
  model: 'claude-3-5-sonnet',
  resourceGroup: 'default',
  credentials: {
    clientId: 'sb-xxx',
    clientSecret: 'secret',
    tokenServiceUrl: 'https://auth.example.com/oauth/token',
    servicUrl: 'https://api.ai.example.com',
  },
  log: console, // optional: log debug/error messages
});

const agent = new SapCoreAIAgent({
  mcpClient,
  llmProvider: provider,
});
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

## Tool Format Conversion

MCP tools are converted to OpenAI function format before being sent to SAP AI Core. The `SapCoreAIAgent` handles this conversion automatically.

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

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `AICORE_SERVICE_KEY is not set` | Missing env var | Export the service key JSON |
| `401 Unauthorized` | Invalid or expired credentials | Regenerate service key in BTP cockpit |
| `Model not found` | Model not deployed | Deploy the model in SAP AI Core Launchpad |
| `Resource group not found` | Wrong resource group | Check `SAP_AI_RESOURCE_GROUP` value |
| `OAuth2 token error` | Wrong `tokenServiceUrl` | Verify the URL from service key `uaa.url` |
| `400 "Either a prompt template or messages must be defined"` | SDK requires `prompt.template` | Fixed in v2.9.0 — upgrade the package |
| `400 "Unused parameters"` | Using `messagesHistory` instead of `messages` | Fixed in v2.9.0 — upgrade the package |
| `Stream finished with token length exceeded` | `maxTokens` too low for tool-calling models | Set `maxTokens: 32768` or higher in config |
