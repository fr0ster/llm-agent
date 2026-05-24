# Share the resolved embedder with `pipeline.rag.tools` (subagent context-builder) — #141

> **Status:** Design, approved. Closes [#141](https://github.com/fr0ster/llm-agent/issues/141). Follow-up to #137.
>
> **Release target:** 16.1.0 (with #135).

## Problem
`SmartServer._buildAgent` resolves a shared embedder from the **flat** `this.cfg.rag` (`resolveAgentEmbedder`, smart-server.ts ~line 443) and uses it both for the flat RAG and the subagent context-builder's `toolSource` (`mainEmbedder = resolvedEmbedder`, ~line 625). #137 fixed the flat path. But the **multi-store** path (`pipeline.rag.{name}`, ~line 482-490) builds each store with `injectedEmbedder: this.cfg.embedder` (raw DI) and assigns the `tools` store to `toolsRag`. For a YAML-only deployment using `pipeline.rag.tools` (no flat `rag:` block):
- `this.cfg.rag` is undefined → `resolvedEmbedder` is undefined → `mainEmbedder` undefined → `toolSource` undefined → constrained subagents fail with empty context (same failure #137 fixed, but on the multi-store path).

## Design (mirror #137 for the `tools` store)
No interface changes. Reuse `resolveAgentEmbedder`.

In `smart-server.ts._buildAgent`:
1. Change `const resolvedEmbedder` (~line 443) to `let resolvedEmbedder`.
2. In the `pipeline?.rag` loop, for the store named `tools` specifically: if `resolvedEmbedder` is still `undefined` (the flat path produced none), resolve it from THAT store's config —
   ```ts
   if (name === 'tools' && !resolvedEmbedder) {
     resolvedEmbedder = await resolveAgentEmbedder(
       storeCfg as SmartServerRagConfig,
       this.cfg.embedder,
       mergedEmbedderFactories,
     );
   }
   ```
   and build the `tools` store with `injectedEmbedder: resolvedEmbedder ?? this.cfg.embedder` (so the tools store and the context-builder share one embedder instance).
3. **Other stores are unchanged** — they keep `injectedEmbedder: this.cfg.embedder`, so a store that declares its own different `embedder` is NOT forced onto the tools embedder. Only the `tools` store (the one feeding `toolSource`) gets the shared resolved embedder.
4. The existing context-builder wiring (`mainEmbedder = resolvedEmbedder`, ~line 625, runs after the `pipeline.rag` loop) then picks it up for the multi-store case automatically.

The `pipeline.rag` loop currently uses a single shared `ragOptions` for all stores. Split the `injectedEmbedder` per-store so only `tools` uses the resolved embedder (e.g. build `ragOptions` inside the loop, or pass a per-store `injectedEmbedder`). Keep `extraFactories` shared.

### Behavior preservation
- DI-injected `this.cfg.embedder` still wins (it's the first branch in `resolveAgentEmbedder`, and the `?? this.cfg.embedder` keeps it for non-tools stores). Existing DI deployments unchanged.
- Flat `rag:` path unchanged (#137 already covers it; `resolvedEmbedder` is set before the pipeline branch and the `!resolvedEmbedder` guard skips re-resolution).
- A bare in-memory `tools` store with no embedder → `resolveAgentEmbedder` returns undefined → `toolSource` stays undefined (correct — BM25, no vector retrieval source), same as the flat case.

## Out of scope
- Per-store embedder resolution for non-`tools` pipeline.rag stores (they keep current behavior).
- Any change to `resolveAgentEmbedder` or interfaces.

## Testing
- Server/handler-level test (offline, stub embedder factory via `embedderFactories`): build a `SmartServer` with a `coordinator:` block + a `pipeline.rag.tools` store declaring an embedder (e.g. `{ type: 'in-memory', embedder: '<stub>', model: 'm' }`) and **no** `SmartServerConfig.embedder` DI and **no** flat `rag:` block. Assert the subagent context-builder receives a non-undefined `toolSource` (or, at the observable level, the `tools` store + context-builder get the resolved embedder). Mirror #137's test approach (`resolve-agent-embedder` is already unit-tested; here assert the multi-store wiring reaches it).
- Regression: flat `rag:` path still resolves the embedder once (unchanged); a `pipeline.rag` store other than `tools` with its own `embedder` is NOT overridden.

## Acceptance criteria
1. YAML-only `pipeline.rag.tools` configs (no DI embedder, no flat `rag:`) wire the subagent context-builder's embedder.
2. DI embedder + flat-path behavior unchanged; non-`tools` stores not overridden.
