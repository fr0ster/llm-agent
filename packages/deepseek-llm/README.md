# @mcp-abap-adt/deepseek-llm

DeepSeek LLM provider for @mcp-abap-adt/llm-agent / @mcp-abap-adt/llm-agent-libs.

Extends `OpenAIProvider` from `@mcp-abap-adt/openai-llm`. Calls DeepSeek /v1/chat/completions API (OpenAI-compatible).

Exports:
- `DeepSeekProvider` — extends OpenAIProvider, implements ILlm.
- `DeepSeekConfig` — configuration type.

Optional peer dependency of @mcp-abap-adt/llm-agent-libs. Install when smart-server.yaml names `deepseek` as LLM provider, or when constructing DeepSeekProvider programmatically.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) — see
[`LICENSE`](LICENSE) (LGPL) and [`COPYING`](COPYING) (the GPL it layers
permissions onto; both are required, the LGPL is not standalone).

Copyright © 2025–2026 Oleksii Kyslytsia

Importing this package, or running it behind an HTTP endpoint, does not place
your program under the LGPL — the licence asks that modifications *to this
library* stay free and that your users can substitute their own build.
Versions up to and including v20.9.5 were MIT and stay MIT; the change is not
retroactive. Full detail, including what to do if you redistribute:
[docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).
