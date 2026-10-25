# @mcp-abap-adt/sap-aicore-llm

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

SAP AI Core LLM provider for @mcp-abap-adt/llm-agent / @mcp-abap-adt/llm-agent-libs.

Exports:
- `SapCoreAIProvider` — implements ILlm, calls SAP AI Core orchestration API.
- `SapCoreAIConfig` — configuration type.
- `buildDestination` — builds the SDK's constructed-destination shape from a
  `credential` + `apiBaseUrl`; exported mainly for tests.

Optional peer dependency. Install when smart-server.yaml names `sap-ai-sdk` as LLM provider, or when constructing SapCoreAIProvider programmatically.

## Usage

`SapCoreAIConfig.credential` (an `IBearerCredential` from
`@mcp-abap-adt/interfaces-auth`) and `.apiBaseUrl` are required — this package
reads no environment variable itself. Build them from a raw SAP AI Core
service-key JSON string with `serviceKeyCredential`:

```ts
import { SapCoreAIProvider } from '@mcp-abap-adt/sap-aicore-llm';
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';

const provider = new SapCoreAIProvider({
  model: 'gpt-4o',
  ...serviceKeyCredential(process.env.AICORE_SERVICE_KEY!),
});
```

`credential.token()` is asked fresh on every `chat()`/`streamChat()` call —
including each retry attempt — never cached on the provider instance, so a
rotating token keeps rotating.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) — see
[`LICENSE`](LICENSE) (LGPL) and [`GPL-3.0.txt`](GPL-3.0.txt) (the GPL it layers
permissions onto; both are required, the LGPL is not standalone).

Copyright © 2025–2026 Oleksii Kyslytsia

Importing this package, or running it behind an HTTP endpoint, does not place
your program under the LGPL — the licence asks that modifications *to this
library* stay free and that your users can substitute their own build.
Versions up to and including v20.9.5 were MIT and stay MIT; the change is not
retroactive. Full detail, including what to do if you redistribute:
[docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).

## Usage analytics

Provider configuration accepts `usage?: IUsageRecorder` from
`@mcp-abap-adt/llm-agent`. A call's `{ usage }` overrides the bound recorder;
without either, collection is a no-op. Library adapters forward these options.
Records describe physical requests inside retry/chunk loops, with a shared
`operationId`, unique `physicalSeq`, attempt coordinates and embedding
`chunkPath`. Token totals are the exact provider values for each request,
or marked unknown when unavailable. No prompt, document, argument, result or
credential content is recorded. Streams also record failures, cancellation
and early consumer close (`closedEarly: true`).

SAP orchestration disables SDK inference retries where supported. SDK calls
with hidden retries use `granularity: 'sdk-call'` and `retriesVisible: false`.

Use the buffered recorder from `@mcp-abap-adt/llm-usage`, or supply your own
`IUsageRecorder`. See the [usage overview](../../docs/USAGE_ANALYTICS.md) for
injection, replaceable transports/sinks and delivery/loss semantics.
