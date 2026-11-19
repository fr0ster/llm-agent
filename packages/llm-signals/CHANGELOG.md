# @mcp-abap-adt/llm-signals

## 1.0.6

### Patch Changes

- Updated dependencies [37f93cc]
  - @mcp-abap-adt/llm-agent@35.0.0

## 1.0.5

### Patch Changes

- Updated dependencies [df0d78f]
- Updated dependencies [b589bbf]
- Updated dependencies [b589bbf]
  - @mcp-abap-adt/llm-agent@34.0.0

## 1.0.4

### Patch Changes

- Updated dependencies [4bcdb59]
- Updated dependencies [1215f53]
- Updated dependencies [79507a7]
  - @mcp-abap-adt/llm-agent@33.0.0

## 1.0.3

### Patch Changes

- Updated dependencies [ee1ec0e]
  - @mcp-abap-adt/llm-agent@32.0.0

## 1.0.2

### Patch Changes

- Updated dependencies [57f731c]
  - @mcp-abap-adt/llm-agent@31.0.0

## 1.0.1

### Patch Changes

- 6794fcf: Accept plain-data payloads created in another realm (a vm context or a test runner sandbox, for example objects from `structuredClone` under Jest); the check reads data descriptors only (no payload accessor runs), and class instances from any realm, including null-base classes, are still rejected. The check guards against producer mistakes, not deliberately forged objects such as proxies.

## 1.0.0

- Add the synchronous retained signal bus and replaceable emitter composition helpers.
