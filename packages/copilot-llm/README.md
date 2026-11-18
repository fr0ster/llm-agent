# @mcp-abap-adt/copilot-llm

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

GitHub Copilot LLM provider for `@mcp-abap-adt/llm-agent`, backed by the official GitHub Copilot SDK.

```ts
import { CopilotProvider } from '@mcp-abap-adt/copilot-llm';

const llm = new CopilotProvider({ model });
try {
  const response = await llm.chat([{ role: 'user', content: 'Hello' }], [], { apiKey });
  if (response.ok) console.log(response.value.content);
} finally {
  await llm.dispose();
}
```

Pass the caller's GitHub Copilot token in `CallOptions.apiKey` on each call, including `getModels`. The caller supplies and refreshes the token. A rejected token returns `CREDENTIALS_REJECTED`. Pass an `AbortSignal` in `CallOptions.signal` to cancel a call.

Use `streamChat` for incremental output. For tool calls, execute the requested tools and append their results as `tool` messages with the matching `tool_call_id` before calling the provider again.

## Prompt caching

Setting `promptCaching` on or off has no effect for this provider.

## Manual service probe

With `COPILOT_TOKEN` already set in the process environment, run this from the repository root.

```sh
node --import tsx/esm packages/copilot-llm/scripts/probe.ts
```

The probe checks the available models and verifies that a new turn starts with the supplied messages. It reports pass or failure to the terminal and runs separately from the test suite.

## License

GNU Lesser General Public License v3.0 only (`LGPL-3.0-only`). See [LICENSE](LICENSE) and [GPL-3.0.txt](GPL-3.0.txt).
