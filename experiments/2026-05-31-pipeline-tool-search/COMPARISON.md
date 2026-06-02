# DAG vs cyclic / planned / deep — pipeline analysis

Bare prompt, no seed, no skills. SAP AI Core for every role. MCP :3001 (v6.11.0, live).
Prompt: `Review ABAP program ZDAZ_R_DELAYED_UPDATE, check security, performance, CleanCore, maintainability`.
Result table: see `METRICS.md`. Raw tool-search traces: `tool-search/`. Answers: `answers/`.

> The runtime (`llm-agent`) is agnostic in all four — tools are always discovered at
> runtime and chosen by semantic similarity to tool **descriptions**, never by hardcoded
> name. A concrete deployed pipeline MAY be non-agnostic (e.g. a domain worker prompt),
> and that is a normal, intended case. The control run below isolates that variable.

---

## 1. The pipelines (structure)

| | DAG (старший) | cyclic-react | planned-react | deep-stepper |
|---|---|---|---|---|
| Planner | LLM (sonnet) | trivial (1 node = raw prompt) | LLM (sonnet) | LLM, **recursive** |
| Decomposition | yes | **none** | yes | yes, per level |
| Leaf executor | **worker subagent = full pipeline** (classify → rag/tool-select → assemble → **tool-loop, 25 iters**) | `CyclicReActExecutor` (ReAct, 10 iters) | same executor, per leaf | same executor, per node |
| Tool selection | **refreshed every iteration** (`tools_refreshed`) | **seeded once** (`executor_tool_seed`) + reactive `needResolver` | seeded once + needResolver | seeded once + needResolver |
| readOnly safety gate | **no** (plain tool-loop) | **yes** (`mutationPolicy: confirm`) | yes | yes (`trusted`) |
| Worker systemPrompt | configurable (domain or generic) | fixed agnostic `EXECUTOR_SYSTEM` | fixed agnostic | fixed agnostic |

The decisive structural differences are the last three rows.

---

## 2. Prompt → plan decomposition

- **DAG** — planner emits essentially ONE analysis node and dispatches the whole task to the
  `abap-analyst` worker. The heavy lifting is in the worker's tool-loop, not the plan.
- **cyclic** — NO decomposition. The trivial planner's single node goal = the raw prompt.
  Nothing tells the executor to fetch the source first.
- **planned** — planner decomposed into two nodes (trace `answers/`):
  `"Fetch source … using GetProgram"` + `"Perform syntax check … using CheckProgram"`.
  It **named tools**, **omitted the includes entirely**, and the CheckProgram node tripped
  the readOnly gate (`ClarifySignal: CheckProgram is not declared read-only`) → coordinator
  error → empty answer. So planned both under-planned and self-aborted.
- **deep** — planner recursed into **107 child Steppers** but never reached a grounded tool
  call (0 MCP calls), burned the 300 k budget, and returned
  `"The token budget … has been exhausted. How many additional tokens…?"`. Root-planner
  decomposes endlessly without anchoring to real data — the 18.1 problem.

---

## 3. Tool work — specifically tool SEARCH (the crux)

**Mechanism (all four, agnostic):** embed a query text → cosine match against embeddings of
the MCP tool **descriptions** → take top-k (`tool:`-prefixed RAG ids).

**What the bare prompt surfaces (top-10, from `tool-search/`):**

| pipeline | top tools by similarity | `GetInclude` in top-10? | `GetProgram`? |
|---|---|---|---|
| cyclic | UpdateLocalDefinitions, UpdateProgram, UpdateLocalTypes, CheckProgram, DeleteProgram, **GetProgram #8**, ActivateProgram, CreateProgram | **no** | yes (#8) |
| DAG worker | GetAbapSemanticAnalysis, CheckProgram, SearchSource, **GetProgram #4**, UpdateBehaviorImplementation, DeleteProgram, … | **no** | yes (#4) |

> "review **program** X" embeds close to the **…Program write tools** (Update/Delete/Activate/
> Create). `GetInclude` is **not in the top-10 of ANY pipeline** — the prompt never says "include".

**So why does DAG read all 6 includes and the Steppers don't?** Not the seed ranking (both miss
GetInclude), not the domain prompt (generic DAG is identical), not include-planning (no pipeline
plans includes). The single cause:

- **DAG worker re-selects tools EVERY iteration** (`tool-search/dag__28_tools_refreshed.json`).
  Iter 1 calls `GetProgram`; the returned source contains `INCLUDE zdaz_r_delayed_update_f01.` …;
  iter 2 **refreshes** the tool set over the now-richer conversation → the refreshed set contains
  `GetInclude` + `GetIncludesList` → the worker calls `GetInclude` ×6. **Iterative tool-refresh
  over the evolving context is what discovers the includes.**
- **cyclic** seeds tools ONCE before the loop and only re-queries if the model *voices* an unmet
  need (`needResolver`). The haiku executor produced a final answer on turn 1 (satisficed) →
  **0 tool calls**, never even fetched the source → fabricated/hedged review.
- **planned** — same one-shot seed; died on the readOnly gate before any tool ran.
- **deep** — never reached a grounded executor tool call at all.

---

## Conclusion

1. The **runtime is agnostic** in all four; the agnostic→non-agnostic line is the deploy DATA
   layer (worker prompt / `knowledgeSeed` / skills). Confirmed: generic-prompt DAG == domain DAG.
2. The DAG advantage is **structural, in the tool-loop**: per-iteration **tool-refresh** (re-run
   tool-search over the growing conversation) + a deep iteration budget + no readOnly gate aborting
   mid-run. Once the source reveals the include names, the refresh surfaces `GetInclude`.
3. The Stepper executor's weakness: **one-shot tool seed** + reactive `needResolver`. A satisficing
   model never voices a need, so the seed (which lacks `GetInclude`) is never corrected.
4. **18.1 levers for the Stepper executor:**
   - Re-run tool-search every iteration over the evolving messages (port the DAG `tools_refreshed`
     behaviour) — the most direct fix; makes include-following emergent, no seed needed.
   - Keep `knowledgeSeed` as the operator override for thoroughness (already proven to work).
   - Fix the readOnly gate so a non-read-only tool yields a graceful skip, not a run-killing error
     (planned died on `CheckProgram`).
   - deep-stepper: root planner must anchor each sub-goal to real retrieval before recursing
     (it recursed 107× with 0 tool calls).
