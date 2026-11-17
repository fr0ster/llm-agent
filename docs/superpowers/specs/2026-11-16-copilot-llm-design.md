# GitHub Copilot LLM provider (`copilot-llm`) — design

Status: draft for review. Date: 2026-11-16.

## Intent

A new package `@mcp-abap-adt/copilot-llm` implements `ILlm` on top of the official GitHub Copilot SDK
(`@github/copilot-sdk`, GA 2026-06-02). Each user works on their own Copilot subscription with their own token. The
provider stores nothing: the caller passes the token with every call.

GitHub Models (`models.github.ai`) was retired on 2026-07-30 and is not an option. The undocumented
`copilot_internal` token exchange is not used.

Decisions by the user, 2026-11-16:
- "Якшо креди в кожного юзера своі то ніц не зберігаємо… юзер присилає токен, провайдер його використовує… кліент хай
  дума як йому токен отримувати" — no OAuth flow, no refresh, no token store;
- "не зберігати ніц а брати хедер кожного разу" — in the hub the token comes from a request header on every request,
  like SAP credentials; never as a tool argument (it would pass through the client's model);
- "Один копайлот на хід то оверхед великий… один копайлот на всіх теж перебор. Ідеально один на сесію" and then
  "процес на інстанс, одна сесія Copilot на сесію хаба, rewind на початку кожного ходу — Так";
- history: the model gets the current turn plus what retrieval finds, not the whole chat (same rule as the hub's
  `LLM_AGENT_CLIENT_HISTORY=off`).

## Facts from the PoC (`poc/copilot/probe.mjs`, `probe2.mjs`, SDK 1.0.34, runtime 1.0.112)

| Question | Result |
| --- | --- |
| Models | `listModels()` returns Claude (opus/sonnet/haiku 5.5…), GPT‑6.x, Gemini 4, Grok, … |
| Model only | `systemMessage: { mode: 'replace' }` replaces the whole system prompt; `availableTools: []` plus `excludedTools` `builtin:*`, `mcp:*` disables built-in tools. Verified (`MODEL_ONLY_OK`). |
| Tool calls to the caller | A tool declared without a handler raises `external_tool.requested`; the caller answers with `session.rpc.tools.handlePendingToolCall({ requestId, result })` and the turn continues. An async handler that waits for the caller works too. |
| Streaming | `streaming: true` → `assistant.message_delta` events. |
| Usage | `assistant.usage` per model call: input, output, cacheRead, cacheWrite, reasoning tokens, AI credits. The runtime caches prompts itself. |
| History | One `prompt` per send; the session owns the conversation. No import of role messages. `session.rpc.history.rewind({ eventId, mode: 'conversation' })` to the first `user.message` wipes it (model answers UNKNOWN afterwards, next turn works). |
| Credentials | The runtime starts without any token (`useLoggedInUser: false`). `SessionConfig.gitHubToken` is per session, documented as multitenancy. An invalid token fails `createSession` with `ResponseError` code −32603. |
| Cost | `createSession` ≈ 0.2–0.3 s; warm turn ≈ 0.8 s (first cold turn 6 s). Runtime ≈ 57 MB idle, ≈ 118 MB with one session, ≈ 4 MB per extra session. |
| Timeouts | `sendAndWait` has a 60 s default → use `send` plus events; no deadlines of our own. |

## Design

### Runtime

One `CopilotClient` (one `copilot-runtime` child process over stdio) per provider host process, started lazily on the
first call, without a client credential. It is stopped on `dispose()` / process exit. If the runtime dies, the next call
starts a new one; sessions bound to the old runtime are dropped (their conversations are wiped every turn anyway).

### Same contract as every provider

To the consumer Copilot is an ordinary `ILlm`, used exactly like the OpenAI, Anthropic, DeepSeek or SAP AI Core
providers (user, 2026-11-16: "все має однакове бути в цьому питанні"):

- the consumer keeps one provider client per caller session and configuration (the hub's `SessionLlms`), passes the
  full input on every `chat()` (system prompt, current turn with retrieved context, tools) and the credential in
  `CallOptions.apiKey`, and disposes the client when its session ends;
- no Copilot-specific knob, session id or lifecycle call reaches the consumer or the shared contract.

### Copilot session (provider-internal mechanics)

The SDK keeps the system prompt, tools and conversation inside a Copilot session, so the provider maps stateless calls
onto one Copilot session itself, like an HTTP provider manages its connections. User, 2026-11-17: the long-session key
already binds clients ("В нас і так є ключ довгої сесії і цього досить"); clients are per long session **and role** for
every provider in the hub ("Як робити на роль провайдера то треба для всіх провайдерів в хабі так робити"); calls that
share a client queue in arrival order ("хто перший встав того і капці").

- one provider client = one Copilot session, created on the first call with that call's system prompt, tools and
  model, and rewound at each new turn;
- calls on one client are served in arrival order (FIFO), one at a time; a waiting call has no deadline, abort cancels
  it;
- a turn that returned tool calls does not hold the session while the caller runs the tools. If a new turn arrives
  first, the provider aborts the waiting Copilot turn and serves the new one. The waiting caller's continuation then no
  longer matches a pending call and is served as a new turn: its full input (request, tool calls, tool results) is
  rendered into the prompt, so the answer is the same, at the cost of one extra model call. Holding the session instead
  would block every later call forever when a caller abandons its turn (for example after a terminal tool failure),
  because nothing else ends a turn: there are no timeouts;
- if a call nevertheless brings a different system prompt, tool set or model than the session was created with, the
  provider closes the session and creates a new one (≈ 0.3 s) rather than sending a mismatched request;
- `dispose()` closes the session.

### Credentials

`CallOptions` gains a provider-agnostic per-call credential, e.g. `apiKey?: string`, documented as "a credential for
this call that overrides the provider's configured key". It is never logged, traced or stored. Copilot uses it as the
session token; the same field later serves the hub's "header key overrides the configured key" plan for OpenAI,
Anthropic and DeepSeek. Providers that cannot honour it (SAP AI Core) ignore it.

A Copilot session is created with the call's token. When a later call brings a different token (fingerprint comparison,
no token kept beyond the live session object), that Copilot session is closed and recreated with the new token: ≈ 0.3 s, and
nothing is lost because the conversation is rewound every turn.

### Turn mapping (`chat` / `streamChat`)

llm-agent calls `chat(messages, tools)` once per model step; the caller executes tool calls and calls again with the
results appended.

1. **New turn**: the trailing messages do not answer a pending tool call of the Copilot session. Then:
   - rewind the session conversation to its first `user.message` (no-op on a fresh session);
   - render the input as one prompt: the non-system messages of `messages` in order, each tagged with its role; the
     system messages are the Copilot session's system prompt (part of its hash);
   - `send({ prompt })` and collect events until the turn reaches a tool request or ends.
2. **Tool request**: on `external_tool.requested`, return `LlmResponse` with `toolCalls` (id = `toolCallId`, name,
   arguments) and `finishReason: 'tool_calls'`. The Copilot turn stays open, waiting.
3. **Continuation**: the next call's trailing `tool` messages carry results for the pending `toolCallId`s; answer each
   with `handlePendingToolCall` and keep collecting events of the same Copilot turn.
4. **End**: on `session.idle` with a final `assistant.message`, return `content` and `finishReason: 'stop'`.

`streamChat` emits `assistant.message_delta` as content chunks and the tool calls as tool-call chunks; usage comes from
`assistant.usage` events summed per call (input, output, `cachedInputTokens` = cacheRead,
`cacheCreationInputTokens` = cacheWrite). `promptCaching` has no request effect: the runtime caches by itself.

Abort: `options.signal` aborts the Copilot turn (`session.abort()`), rejects pending tool calls and returns `ABORTED`.
No timeouts.

### Errors

- invalid or expired token (createSession or send rejects with an authentication error) →
  `LlmError` code `CREDENTIALS_REJECTED`, message "Copilot token rejected — log in again and send a fresh token". No
  retries with the same token;
- quota / rate limit (`session.error` with `errorType` `quota` / `rate_limit`) → the existing 429 path: wait per the
  reported retry hint if any, otherwise the shared backoff; only abort cancels;
- other runtime errors → `LlmError` with the SDK's error class and code, never its message text (it can echo headers).

### Models

`getModels()` maps `listModels()` (needs a token: uses the call's `apiKey`). The configured `model` is passed to
`createSession`; per-call `options.model` changes the hash, so the session is recreated with that model.

## Out of scope

- OAuth, refresh, token storage (client's job);
- hub wiring (separate change: header → `CallOptions.apiKey`, disposing session clients on hub session end as for every
  provider, expired-token message to the client, pausing background work until a fresh token arrives);
- real expiry test (needs a token that expires during a run).

## Tests

- unit, with a fake SDK client: reuse across turns, recreate on a different prompt/tools/model, FIFO for concurrent calls, new turn → rewind, tool request →
  `toolCalls`, continuation → `handlePendingToolCall`, streaming chunks, usage mapping, token change → recreate,
  auth failure → `CREDENTIALS_REJECTED`, abort, `dispose()` closes the session, nothing logs the token;
- manual service probe (like `probe2.mjs`) behind an env token, not in CI.
