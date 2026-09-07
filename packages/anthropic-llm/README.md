# @mcp-abap-adt/anthropic-llm

Anthropic (Claude) LLM provider for @mcp-abap-adt/llm-agent / @mcp-abap-adt/llm-agent-libs.

Exports:
- `AnthropicProvider` — implements ILlm, calls Anthropic /v1/messages.
- `AnthropicConfig` — configuration type.

Optional peer dependency of @mcp-abap-adt/llm-agent-libs. Install when your smart-server.yaml names `anthropic` as the LLM provider, or when constructing AnthropicProvider programmatically.

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
