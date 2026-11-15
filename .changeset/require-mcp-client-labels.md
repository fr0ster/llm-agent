---
'@mcp-abap-adt/llm-agent': major
'@mcp-abap-adt/llm-agent-libs': major
'@mcp-abap-adt/llm-agent-server-libs': major
---

Require a non-empty descriptor label for every MCP client when building with more than one client. Positional `s<slotIndex>` prefixes change when clients are reordered, making exposed tool names unsuitable as stable cache keys. Empty descriptor labels are rejected even for a single client.

This is a breaking change: `withMcpClients([a, b])`, multiple undescribed servers, mixed labeled/unlabeled clients, and custom connection/session factories returning multiple unlabeled clients now throw an explicit Error during build, before listing tools. A single unlabeled client remains supported with prefix `s0`.

Migrate to `withMcpServers()` with each server carrying `descriptor: { slotIndex, label: 'stable-name' }`, or give every YAML `mcp:` entry a stable `name`. Wrap already-connected clients in labeled servers whose `start()` returns the client and whose `stop()` follows the caller's ownership policy. Custom connectors must return labeled `clientDescriptors` (use `connectMcpWithDescriptors` for SmartServer). `ControllerSkillPipelineBuilder.withMcp()` now accepts `name` for configuring multiple servers. Labels are preserved when SmartServer reuses clients across session and worker builds.
