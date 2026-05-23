# Surface YAML `rag.embedder` to the subagent context-builder

> **Status:** Design, approved. Closes [#137](https://github.com/fr0ster/llm-agent/issues/137).
>
> **Release target:** v15.x (minor). Own PR.

## Problem

`SmartServer._buildAgent` (`packages/llm-agent-server/src/smart-agent/smart-server.ts:600`) builds the subagent context-builder's `toolSource` only when a **DI-injected** embedder is present:

```ts
const mainEmbedder = this.cfg.embedder;
const toolSource =
  mainEmbedder && toolsRag ? async (text, k, signal) => { ... } : undefined;
```

For **YAML-only** deployments — where the embedder is configured via `rag.embedder` and constructed inside `makeRag()` rather than DI-injected via `SmartServerConfig.embedder` — `this.cfg.embedder` is `undefined`, so `toolSource` is `undefined`. Constrained subagents then fail with *"contextPolicy=required but builder produced empty context"*. This was a documented v13.0.0 Phase-1 limitation.

## Design (option C — resolve embedder once, share it)

No interface changes. In `_buildAgent`, resolve the embedder a single time and use the same instance for BOTH `makeRag` (as `injectedEmbedder`) and the context-builder's `toolSource`.

`resolveEmbedder` is already exported from `@mcp-abap-adt/llm-agent-rag`; `prefetchEmbedderFactories` too.

### Changes (all in `smart-server.ts._buildAgent`)

1. Before the RAG wiring (currently ~line 455), compute a shared embedder:
   ```ts
   let resolvedEmbedder = this.cfg.embedder;
   if (!resolvedEmbedder && this.cfg.rag && ragNeedsEmbedder(this.cfg.rag)) {
     await prefetchEmbedderFactories([this.cfg.rag.embedder ?? 'ollama']);
     resolvedEmbedder = resolveEmbedder(this.cfg.rag, {
       extraFactories: mergedEmbedderFactories,
     });
   }
   ```
   where `ragNeedsEmbedder(rag)` is true when an embedder is actually used, mirroring `makeRag`'s own rule:
   `rag.type !== 'in-memory' || rag.embedder != null`.
   (A bare `in-memory` BM25 store needs no embedder — do NOT resolve one, otherwise `resolveEmbedder` would default to `ollama` and falsely require it.)

2. Pass `resolvedEmbedder` as `injectedEmbedder` in the `ragOptions` used for `makeRag` (replacing `this.cfg.embedder`), so the RAG and the context-builder share one embedder instance.

3. Use `resolvedEmbedder` as `mainEmbedder` for the `toolSource` (replacing `this.cfg.embedder` at line 600).

### Out of scope
- The sub-agent builder (`_buildSubAgent`, ~line 862) has no context-builder/`toolSource` wiring — unchanged.
- No change to `IRag`, `makeRag` signature, or `resolveEmbedder`.
- Pure in-memory (BM25, no embedder) deployments keep `toolSource = undefined` — correct, there is no embedder to build a vector retrieval source from.

## Backwards compatibility
- DI-injected `this.cfg.embedder` still wins (the `??` keeps it first) — existing behavior unchanged.
- Programmatic `SmartAgentBuilder.withEmbedder(...)` path unaffected.

## Testing
Add a server test (`packages/llm-agent-server/src/smart-agent/__tests__/`) that builds a `SmartServer` with:
- a `coordinator:` block (so the context-builder path runs),
- a `rag:` block with an embedder (e.g. `type: in-memory, embedder: <stub>` or an injected `extraFactories` stub embedder) but **no** `SmartServerConfig.embedder` DI,
and asserts the constructed agent's subagent context-builder has a non-undefined `toolSource` (or, at the observable level, that constrained-subagent dispatch produces non-empty context instead of the empty-context error).
Use a stub embedder factory via `embedderFactories` to avoid needing a live Ollama in tests.

Also keep a regression assertion: a bare `rag: { type: in-memory }` (no embedder) yields `toolSource = undefined` (no accidental ollama requirement).

## Acceptance criteria (from #137)
1. YAML-only configs (no DI embedder) wire `toolSource` correctly. ✓ via shared resolve.
2. `examples/sap-ai-core-direct/smart-server.yaml` minus the DI embedder → constrained subagent dispatch succeeds.
3. DI-injected embedder still works. ✓ (`??` precedence).
