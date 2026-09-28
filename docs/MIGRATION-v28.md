# Migrating to v28.0.0

## TL;DR

- **No API changed.** No import, type, class, config key or environment variable moved.
- **The install contract changed.** Every library package now takes the `@mcp-abap-adt/*`
  packages it uses as **peer dependencies** instead of regular ones — each other
  (`llm-agent`, `llm-agent-mcp`, `llm-agent-rag`, `llm-agent-libs`, `openai-llm`,
  `sap-aicore-auth`) and the shared contracts `@mcp-abap-adt/interfaces-auth` (`^2.1.0`) and
  `@mcp-abap-adt/interfaces-utils` (`^1.1.0`).
- **Why:** your install now holds exactly **one** copy of each. Before, a version skew between
  our packages, or an `interfaces-auth` of your own outside our range, made npm nest a second copy
  silently.
- **The binary is unaffected.** `npm install -g @mcp-abap-adt/llm-agent-server` works as before; it
  is the root of its own tree and keeps them as regular dependencies.

## Why one copy matters

Two copies of `@mcp-abap-adt/llm-agent` are not just wasted disk:

- `llm-agent-mcp` checks `instanceof McpError`, and `llm-agent-libs` checks `instanceof`
  `ClarifySignal`, `NeedInfoSignal` and `CatalogCasError` — all classes of `llm-agent`. An
  instance created by one copy is not an instance of the other copy's class, so those checks
  silently fail (a clarification request handled as a plain error, for example).
- The LLM throttle keeps its gates in module state; two copies throttle independently.

Two copies of an interface package are two versions of the same contract in one program.

## What you do

| Your setup | What to do |
|---|---|
| npm ≥ 7 or pnpm ≥ 8, all our packages on 28.x, no `interfaces-*` of your own | Nothing. Missing peers are installed for you. |
| You depend on `@mcp-abap-adt/interfaces-auth` 1.x yourself (directly or through another package) | Move it to `^2.1.0`. The credential types we use are identical in 1.2 and 2.1. |
| You mix majors of our packages (e.g. `sap-aicore-llm@27` with `llm-agent-libs@28`) | Put every `@mcp-abap-adt/llm-agent*` / provider / store package on the same major. |
| npm with `--legacy-peer-deps`, or Yarn | Peers are not installed for you. Add `@mcp-abap-adt/llm-agent` (and any other of our packages the ones you use name as peers) plus `@mcp-abap-adt/interfaces-auth@^2.1.0` and `@mcp-abap-adt/interfaces-utils@^1.1.0` to your own dependencies. |

A mismatch now fails the install instead of passing silently:

```
npm error ERESOLVE unable to resolve dependency tree
npm error Found: @mcp-abap-adt/interfaces-auth@1.2.0
npm error Could not resolve dependency:
npm error peer @mcp-abap-adt/interfaces-auth@"^2.1.0" from @mcp-abap-adt/deepseek-llm@28.0.0
```

Fix the version it names; do not reach for `--force` or `--legacy-peer-deps` to get past it —
that brings the second copy back.

## For contributors

`test/repo/scoped-dependencies.test.ts` enforces the rule: no library has an `@mcp-abap-adt/*`
package as a regular dependency, every one it imports is declared as a peer, every package uses
the same range for the same package, and the binary provides every required peer of the libraries
it ships.
