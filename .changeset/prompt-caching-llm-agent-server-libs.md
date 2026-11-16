---
"@mcp-abap-adt/llm-agent-server-libs": minor
---

Flat and named `llm` YAML entries and HTTP chat requests accept only the boolean `promptCaching` switch for caching. It defaults to enabled; call options override provider config. Non-boolean values are rejected at YAML/HTTP boundaries. Cache keys, retention controls, and their HTTP aliases are not supported. Providers decide how to apply the switch; automatic provider caching cannot be disabled by the client. Usage summaries preserve cache counters by model.
