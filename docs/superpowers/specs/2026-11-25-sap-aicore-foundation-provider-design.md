# SAP AI Core foundation-models provider — design

Date: 2026-11-25. Status: draft.

## Goal

Call SAP AI Core models through their own foundation-models deployments, without the orchestration service. Some tenants get model deployments but no `orchestration` deployment; the existing provider (`OrchestrationClient`) then fails with "No deployment matched … scenarioId orchestration".

## Facts (probed 2026-11-25 on a tenant with foundation-models deployments only)

- Deployments are listed per resource group (`GET {AI_API_URL}/v2/lm/deployments?status=RUNNING`, header `AI-Resource-Group`); the model name is in `details.resources.backendDetails.model.name`, the base URL in `deploymentUrl`.
- OpenAI-family models (e.g. `gpt-6.1-sol`, `gpt-4o-mini`, `o4-mini`): `POST {deploymentUrl}/chat/completions?api-version=2024-10-21` with the OpenAI chat body returns 200.
- Anthropic-family models (`anthropic--*`, e.g. `anthropic--claude-4.6-sonnet`): `POST {deploymentUrl}/invoke` with the Bedrock Anthropic body (`anthropic_version: "bedrock-2023-05-31"`, `max_tokens`, `messages`, `system`, `tools`) returns the Anthropic message; `POST {deploymentUrl}/converse` also works.
- Auth: client-credentials token from the service key (`@mcp-abap-adt/sap-aicore-auth`), `Authorization: Bearer`, `AI-Resource-Group`.

## Design

New provider in `@mcp-abap-adt/sap-aicore-llm`: `SapAiCoreFoundationProvider` implementing the same `ILlm` contract as the other providers (chat, streaming, tools, usage, typed errors).

- **Deployment resolution:** by model name within the configured resource group. The resolved URL is kept per model and re-resolved when a call returns 404 (deployment gone or replaced). No other cache.
- **Family routing by model name:** `anthropic--*` → Anthropic format on `/invoke` (streaming via the streaming variant the tenant supports — probe `invoke-with-response-stream` / `converse-stream` and their wire format; if AWS event-stream framing is returned, decode it); everything else → OpenAI chat completions with SSE streaming. Request/response mapping reuses the existing OpenAI and Anthropic provider mappers where possible instead of a third copy.
- **Behaviour parity with the other providers:** streamed tool calls with empty arguments complete as `{}`; HTTP 429 with retry-after becomes a throttled `LlmError` with `retryAfterSeconds`; input over the model context becomes `MODEL_CONTEXT_EXCEEDED`; usage reports input, output and cache fields per call; abort signal honoured.
- **Prompt caching:** generic on/off only (provider-agnostic contract); for Anthropic the provider places cache breakpoints itself.
- **No timeouts, no caps** in the provider.

## Consumers

- Provider id `sap-aicore-foundation` next to the existing orchestration provider; the hub selects it with `LLM_AGENT_PROVIDER=sap-aicore-foundation` and `LLM_AGENT_RESOURCE_GROUP`.
- Embeddings already work without orchestration through the foundation embedder in `@mcp-abap-adt/sap-aicore-embedder`.

## Tests

Mocked HTTP: deployment resolution and 404 re-resolution; OpenAI and Anthropic families for chat, streaming, tools (incl. empty arguments), usage, 429, context overflow, abort. A manual live check script (not in CI) against a tenant.
