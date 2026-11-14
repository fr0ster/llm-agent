# Tool cache with a missing-tool fallback — design

Status: draft for review (revision 7). Date: 2026-11-14.

## Intent

A worker (executor) gets a tool set before it calls the model. When the set lacks a tool the step needs, the step
fails or the worker improvises. This design adds one universal recovery path and a cache that learns from it:

1. the worker says "a tool I need is missing" through a dedicated signal tool;
2. a **fallback selector** (universal, in llm-agent) picks tools for that step from the full MCP catalog;
3. the step's complete tool set is written to a **tool cache**, and the step continues with the added tools;
4. the next step reads its tool set from the cache.

The fallback is MCP-agnostic: it uses only what every MCP server exposes. The cache **writer** and **lookup** are
contracts whose implementations belong to the consumer, so a consumer keys the cache with domain knowledge (the hub
does it for mcp-abap-adt), while llm-agent ships generic defaults that make the mechanism work for any MCP server.

Decisions by the user, 2026-11-14:
- the fallback is valued because it builds the cache and is not tied to one MCP server;
- "кеш в хабі це rag чи то векторний чи ні в інмеморі чи в персистенті" — the cache is a RAG collection on whatever
  backend the consumer configures; no separate storage;
- "правила ізоляції не стосуються мсп тулів які в хабі додано від початку і загальний кеш то прям плюс, перший
  зтригерить фолбек аналізатор а інші з кешу візьмуть" — the cache is shared (system-level), not a user collection;
- "не знайдено то llm каже кажете зробити те а тулів в вас нема" — "not found" is decided by the worker's answer, not by
  the lookup; the lookup has no miss rule;
- "нема то додаємо під конкретний випадок" — a failed entry is not rewritten; a new entry is added for the concrete case;
- which entry wins among several is up to the cache implementation.

## Why (measured in the hub, 2026-11-14)

304 generated steps (expected tools chosen from the catalog before the step text was written; equivalent catalog
duplicates accepted), the real POC executor system prompt, model claude-opus-5-5, mcp-abap-adt catalog of 233 tools.
Only the worker's **first** response was evaluated; no SAP execution; later turns were not simulated.

- The hub's current default selection (bge-m3, per-collection 2/1) misses a needed tool in 94 of 304 steps.
- With a `report_missing_tool` signal tool the worker reported the gap in 69–73 of those 94 on its first response
  (run-to-run variance); false alarm 1 of 40 when the set was complete. In ~25 the worker first did preparatory reads.
- The fallback fixed the set for every signal but one (69/69, 71/73, 72/72 in three runs); after continuing, 68–72 of
  94 steps had the needed tools (from 0).
- Fallback catalog text: name + lib one-sentence description ≈ 8.9k input tokens per call; name + description ≈ 22.1k;
  name + description + input schema ≈ 84.6k — with the same accuracy on this sample.
- Cache replay of the fixed steps (exact, renamed objects, paraphrased in another language): nearest-vector lookup
  returned the step's own entry 210/210; an exact-template lookup 140/210 (0/70 paraphrases).
- Nearest-vector lookup alone confuses the operation on the same object: 18/72 wrong entries on create/delete/change/
  read minimal pairs, 94/144 for long cached steps vs short queries. The hub's main-action key + vector among
  same-action entries: 0/72 and 3/144.
- Per step: cache hit ≈ 6.7k input tokens (worker only); signal → fallback → continue ≈ 20.5k.

What these numbers do **not** show: whether a worker that got a wrong set reports the gap on a later turn instead of
doing something else, and whether descriptions alone suffice for catalogs whose tools differ only in their schemas.
Both are covered by tests below; the design does not rely on them being true.

## Goals

- One universal missing-tool path inside the executor tool loop, independent of the MCP server.
- Three contracts with defaults in llm-agent: `IToolFallbackSelector` (llm-agent implementation),
  `IToolCacheLookup` and `IToolCacheWriter` (consumer implementations, generic defaults).
- The cache is a RAG collection on the consumer's configured backend (vector or keyword-only, in-memory or persistent).
- No score thresholds; the model decides relevance (fallback) and the worker decides that something is missing.

## Non-goals

- Replacing the selection strategies; normal tool search runs when the cache has nothing.
- Domain (structured) decomposition in llm-agent — a consumer lookup/writer concern.
- Learning from steps that never reported a missing tool (possible later through the same writer).

## Pipeline

Integration points (current code): tool retrieval is part of the RAG stage, tool exposure is `ToolSelectHandler`
(`packages/llm-agent-libs/src/pipeline/handlers/tool-select.ts`), the loop is `ToolLoopHandler` / `tool-loop-core`.

```
before tool retrieval (a new stage, or a guard on the RAG tool query)
  lookup.find(step) ── entry ──▶ selected = entry.tools validated against the live catalog; tool retrieval skipped
                    └─ none ───▶ normal tool retrieval + selection (unchanged)
ToolSelect
  ctx.activeTools = selected definitions + report_missing_tool (local tool)
ToolLoop round
  model returns tool calls
   ├─ report_missing_tool among them →
   │     the other calls of this round are executed as usual (their results go back as usual);
   │     fallback.select({ step, capability, catalog, alreadyOffered }) → tools
   │     ctx.activeTools = activeTools ∪ definitions(tools)       // the next model call is built from ctx.activeTools
   │     writer.record({ step, tools: offered ∪ tools (complete set), failedEntryId? })
   │     tool_result for the signal call: "added: <names>"
   │     next model call (same request, same messages + tool results)
   └─ a second report_missing_tool in the same step after a fallback → step ends with TOOL_MISSING
```

- The signal tool is a **local** tool of the loop (handled in-process like the hub's local RAG tools), never routed to
  an MCP client. Its description and one system-prompt line tell the worker to call it instead of answering in text
  when a needed capability is absent.
- Pinned set: the signal tool and every tool a fallback added are **pinned for the step**. Each time the loop rebuilds
  its offered tools (`refresh` at `tool-loop.ts` ~348, reselection ~472, any later rebuild), the pinned set is merged
  back in. The pinned set and the "fallback already ran" flag live in the step's state, so a continuation request of
  the same step sees them.
- Rounds with external (client-side) calls: today an unresolved external call surfaces the call and ends the worker
  turn (`tool-loop.ts` ~955/~1084). When such a round also carries the signal, the fallback runs and the cache is
  written first; the turn then ends as today, and the continuation request offers the pinned set.
- Budgets: a signal call does not count toward `maxToolCalls`; `guardToolRound` treats it as a local tool. A signal in
  the last allowed iteration grants exactly one extra round for the continuation. When the tool-call budget is
  exhausted the loop already offers no tools (`currentTools = []`, ~506) — the signal included — so no signal can
  arrive and the step ends as it does today. *Decision by Claude — confirm.*
- "Continue" means one more model call inside the same request (the loop's next round), not a new client request.
- One fallback per step. A second signal after a fallback ends the step with a typed `TOOL_MISSING` error that carries
  the reported capability and goes out the way step errors do today (`ctx.error`, surfaced to the planner).

## Contracts (llm-agent)

```ts
interface IToolFallbackSelector {
  select(input: {
    stepText: string;
    capability: string;               // as reported by the worker
    catalog: readonly McpTool[];      // the live catalog the caller may use, after rights/exposition cuts
    alreadyOffered: readonly string[];
    options?: CallOptions;            // signal aborts the call
  }): Promise<Result<string[], ToolFallbackError>>;
}

type ToolFallbackError =
  | { code: 'FALLBACK_UNAVAILABLE'; message: string }   // model call failed or was aborted
  | { code: 'FALLBACK_INVALID'; message: string }       // no parseable answer
  | { code: 'FALLBACK_EMPTY'; message: string };        // no catalog tool beyond alreadyOffered

interface ToolCacheEntry { entryId: string; tools: string[] }

interface IToolCacheLookup {
  find(input: { stepText: string; catalogFingerprint: string; options?: CallOptions }):
    Promise<Result<ToolCacheEntry | undefined, RagError>>;
}

interface IToolCacheWriter {
  record(input: {
    stepText: string;
    tools: string[];                  // the step's COMPLETE set: everything offered plus what the fallback added
    catalogFingerprint: string;
    failedEntryId?: string;           // the entry whose set lacked the tool, when the set came from the cache
    options?: CallOptions;
  }): Promise<Result<{ entryId: string }, RagError>>;
}
```

- `find` returns an entry whenever the cache has one for the fingerprint; `undefined` only for an empty or unavailable
  cache. There is no miss rule: a wrong entry shows up as the worker's signal and is repaired by the fallback.
- Which entry `find` returns among several is the implementation's choice.
- A fallback error ends the step with `TOOL_MISSING` (with the error code); a lookup error counts as `undefined`; a
  writer error is logged and does not fail the step.
- Validation on read (pipeline): names missing from the live catalog are dropped; an empty set counts as `undefined`.

### Catalog fingerprint

- Prerequisite (separate llm-agent change, before this one): with **more than one** MCP client, every client must have
  a descriptor `label` (the server's config name); otherwise building the agent fails with an explicit error.
  User: "як більше одного кліеета то все не можна без лейбла". Unlabeled clients get the prefix `s<slotIndex>`
  (`build-namespaced-tools.ts` ~47), which depends on their position, so exposed names (and with them tool vectors,
  history and the cache) would drift on a reorder. A single client may stay unlabeled: its prefix is always `s0`
  (the hub passes one composite client through `withMcpClients`). The cache therefore always works.
  `withMcpClients(clients)` carries no labels (they come only from `withMcpServers` descriptors or the YAML `mcp:`
  names), so with two or more clients it fails and the error points to those two paths. That is a breaking change for
  consumers that pass several unlabeled clients; the hub passes one client in every `withMcpClients` call
  (`agent-manager.ts` ~2964, ~3153, ~3878).
- The fingerprint is a hash over the sorted `(client label or "s0", exposed tool name,
  canonical input-schema hash with keys sorted)`. Client order then does not change it.
  Descriptions are not part of it: some are built per request (e.g. planner tools that embed profiles) and would change
  it on every call.
- One fingerprint per tool-loop run, taken when the catalog is listed and passed to lookup and writer alike.

## Default implementations (llm-agent)

- `LlmToolFallbackSelector`: one model call with the catalog listed in a static, prompt-cached system part; answers
  strict JSON `{"tools": [...]}`; names outside the catalog and already-offered names are dropped. The catalog text
  comes from an optional consumer `describeTool(tool) => string`; the default is name + description (no schemas).
- `RagToolCache` (lookup and writer) over a consumer-supplied writable store (`IRag` with `writer()`; constructing it
  over a read-only store is a configuration error):
  - record: a new document per write (`id` = random UUID), text = the step text, metadata
    `{ tools, catalogFingerprint, failedEntryId?, createdAt }`;
  - find: queries the store with the step text and returns the first result whose `catalogFingerprint` matches;
    among equal scores the newest `createdAt` wins, so a correction recorded for the same wording supersedes the
    entry that failed. The query asks for enough results to reach a matching fingerprint; a store that supports
    metadata filters gets the fingerprint as a filter.

## Hub implementation (consumer, for mcp-abap-adt)

- Storage: a system RAG collection from the hub's store factory, on the backend configured for it like the tool corpus
  (in-memory keyword, vector, qdrant, hana-vector, pg-vector). It holds data about the hub's built-in MCP tools, is
  shared by all users and sessions, and is written only by the hub's pipeline (never by user RAG tools).
- Key: the step's main action from the hub's analyzer — its non-read actions `(operation, object)` when it has any,
  else its reads — in metadata; lookup returns, among entries with the same main action, the store's nearest; when the
  fingerprint has entries but none with that main action, it returns the nearest of all entries (the lookup never
  misses while the cache has entries; a wrong set is repaired through the signal).
- Catalog text for the fallback: the lib's one-sentence descriptions.

## Tests (llm-agent)

- Tool loop
  - a `report_missing_tool` call adds the fallback's tools to `ctx.activeTools`; the next model call offers them;
  - the signal is handled locally, not sent to an MCP client; it does not count toward `maxToolCalls`;
  - a round with the signal plus other calls executes the others and returns all results;
  - a second signal after a fallback ends the step with `TOOL_MISSING` carrying the capability via `ctx.error`;
  - fallback errors (`FALLBACK_UNAVAILABLE`, `_INVALID`, `_EMPTY`) and an aborted signal end the step the same way;
  - no fallback when the signal is not called;
  - after a fallback, a refresh and a reselection of the offered tools keep the pinned set;
  - a round with the signal and an unresolved external call: the cache is written, the turn ends as today, the
    continuation request offers the pinned set and a second signal ends the step;
  - a signal in the last iteration gets one continuation round; with the tool budget exhausted no tool (signal
    included) is offered and the step ends as today.
- Cache in the pipeline
  - an entry replaces normal tool retrieval; names absent from the live catalog are dropped; an empty validated set
    and a lookup error fall back to normal retrieval;
  - the writer receives the complete set (initial ∪ added) and `failedEntryId` only when the set came from the cache;
  - bad entry → signal → record → the next `find` for the same wording returns the correction.
- `RagToolCache` on an in-memory keyword store and on a vector store with a deterministic embedder: record → find;
  another fingerprint is not returned; newest wins among equal scores.
- Fingerprint: stable across requests whose descriptions change; independent of client order; differs when a client
  is renamed or a tool schema changes.
- Prerequisite change: building with two or more MCP clients, any of them without a `label`, fails with an explicit
  error; one unlabeled client still builds.
- `LlmToolFallbackSelector`: drops names outside the catalog and already offered; works with a catalog without domain
  metadata; a catalog whose tools differ only in schemas (fixture) — documents whether descriptions suffice.
- Adversarial wrong entry (scripted model): the worker is offered a set without the needed tool and an unrelated
  mutating tool; the test pins what the loop does (signal → fallback) and that no fallback runs without the signal.

## Open

- Later-turn behaviour of the worker on a wrong set (multi-turn simulation in the hub).
- Writing successful steps too (learning without a failure).
- Retention per fingerprint (everything vs latest N per main action).
