# @mcp-abap-adt/llm-usage

## 1.1.0

### Minor Changes

- 34cd979: Expose current unconfirmed delivery counts in usage recorder stats.
- Requires `@mcp-abap-adt/llm-agent` `^30.12.0`, whose `IUsageControl.stats()` declares `unconfirmed`.

## 1.0.0

- Add the usage recorder, delivery transports, memory and JSONL sinks, and shared readers and exports. First release.
