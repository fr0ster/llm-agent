# @mcp-abap-adt/llm-signals

## 1.0.2

### Patch Changes

- Updated dependencies [57f731c]
  - @mcp-abap-adt/llm-agent@31.0.0

## 1.0.1

### Patch Changes

- 6794fcf: Accept plain-data payloads created in another realm (a vm context or a test runner sandbox, for example objects from `structuredClone` under Jest); the check reads data descriptors only (no payload accessor runs), and class instances from any realm, including null-base classes, are still rejected. The check guards against producer mistakes, not deliberately forged objects such as proxies.

## 1.0.0

- Add the synchronous retained signal bus and replaceable emitter composition helpers.
