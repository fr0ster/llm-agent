import {
  artifactIdentityKey,
  ClarifySignal,
  type IExecutor,
  type INeedResolver,
  type LlmComponent,
  type LlmTool,
  type LlmUsage,
  type Message,
  renderTaskSpec,
} from '@mcp-abap-adt/llm-agent';

export interface CyclicReActExecutorDeps {
  llm: import('@mcp-abap-adt/llm-agent').ILlm;
  /** Invoke an MCP tool by name with args; returns the textual result. */
  callMcp: (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<string>;
  component: LlmComponent;
  maxIterations: number;
  /**
   * Always-on unmet-need analyzer. Injected here (NOT only via execute input)
   * so the context-augmenting loop is STRUCTURALLY always-on: the executor is
   * built once and shared by every Stepper mode, so a resolver on its deps can
   * never be left undefined by a forgotten thread-through (the bug this fixes).
   * `execute` input may still override it (tests / per-call tuning).
   */
  needResolver?: INeedResolver;
  /**
   * Optional system-prompt override for the executor. Defaults to the
   * task-agnostic EXECUTOR_SYSTEM. A consumer can override it via
   * `coordinator.flow.executor.systemPrompt` (yaml) or the builder — e.g. to
   * inject domain prerequisites for a cheap executor that lacks a smart planner
   * above it (cyclic mode). Threading it here, not hard-coding domain text in
   * EXECUTOR_SYSTEM, keeps the default prompt agnostic.
   */
  systemPrompt?: string;
  /**
   * How many CONSECUTIVE unmet-need iterations whose tool re-query surfaces NO
   * new tool are tolerated before the executor escalates to the consumer
   * (18.1): analyze answer → find tools → add (preserving existing) → retry; if
   * after this many rounds nothing new helps, the capability is genuinely
   * unavailable → throw ClarifySignal (exit, ask the consumer) instead of
   * returning a silent partial. Default 2 (clamped to ≥ 1).
   */
  maxNoProgressNeeds?: number;
  /**
   * Guard 2b — explicit "no capability" error instead of silent hallucination.
   * When the executor starts with NO tools (empty `input.tools`), the toolsRag
   * seed + needs search return NOTHING, and there are no external tools, the
   * tool subsystem yielded zero capability. A model handed an empty toolset for
   * a task that needs tools will fabricate an answer (observed live: a DAG
   * worker that hit a dead MCP proxy got 0 tools and invented a review from the
   * program name, promptTokens=1224 vs 507650 with a live proxy). By default the
   * executor REFUSES to run toolless and throws ClarifySignal so the consumer
   * learns the capability is missing. Set `true` only for genuinely tool-free
   * reasoning steps. Default false.
   */
  allowToolless?: boolean;
}

/**
 * Task-agnostic tool-use protocol for the executor. It says NOTHING about the
 * task type or any specific tool/MCP — only how to behave when a needed
 * capability is missing or a tool fails. This is what makes the always-on
 * unmet-need detection (INeedResolver) effective: the model is told to VOICE the
 * gap instead of guessing or silently finishing, so a no-tool-call "I need X"
 * utterance is produced, which the tool-definer then turns into a toolsRag
 * re-query. Keep it generic — the runtime is MCP- and task-agnostic.
 */
// NOTE (18.0): the executor is deliberately TASK-AGNOSTIC and does NOT
// self-assess completeness. Completeness/prerequisite judgement is the smart
// model's job — the planner (which now carries a completeness clause) today and
// the dedicated 18.1 Evaluator tomorrow. A cheap executor (e.g. haiku) told to
// "ensure the complete artifact" still satisfices (proven live: gi=0), and a
// task-type clause here breaks the agnostic-prompt invariant. So cyclic ships
// thin: thoroughness comes from the consumer (a knowledgeSeed / prompt
// prerequisite) or from a smart planner above it — never from this prompt.
export const EXECUTOR_SYSTEM = `You complete the task by calling the available tools. If you need a capability the available tools do not provide, or a tool call fails or returns an error / empty / "not found" result, do NOT guess, fabricate, or give a final answer prematurely. Instead, state in ONE sentence the capability you still need (e.g. "I need a tool to <do X>"). Produce your final answer only once you actually have the data the task requires.`;

const ZERO: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const add = (a: LlmUsage, b?: LlmUsage): LlmUsage =>
  b
    ? {
        promptTokens: a.promptTokens + b.promptTokens,
        completionTokens: a.completionTokens + b.completionTokens,
        totalTokens: a.totalTokens + b.totalTokens,
      }
    : a;

export class CyclicReActExecutor implements IExecutor {
  readonly name = 'cyclic-react';
  constructor(private readonly deps: CyclicReActExecutorDeps) {}

  async execute(
    input: Parameters<IExecutor['execute']>[0],
  ): ReturnType<IExecutor['execute']> {
    const { llm, callMcp, component, maxIterations } = this.deps;
    const {
      prompt,
      knowledgeRag,
      toolsRag,
      budget,
      identity,
      taskSpec,
      signal,
      onProgress,
    } = input;
    // Persistent "main task" anchor — rendered ONCE and pinned in the system
    // message, so it survives EVERY iteration (even as tool results pile up) and
    // the executor never loses the overall task. Bounded (a few lines), not the
    // full conversation. Absent → behaves as before.
    const taskAnchor = taskSpec ? `\n\n${renderTaskSpec(taskSpec)}` : '';
    // Always-on: prefer a per-call resolver, else the deps-injected one.
    const needResolver = input.needResolver ?? this.deps.needResolver;
    const ref = {
      stepperId: identity.stepperId,
      parentStepperId: identity.parentStepperId,
      name: this.name,
    };

    // Read the shared blackboard before the first turn so the executor benefits
    // from seeded guidance (e.g. tool-usage routing rules) and prior facts — the
    // planner does this too, but in cyclic-react the planner is trivial, so the
    // executor is the only component that can surface guidance to the model that
    // actually chooses tools. Bounded k + per-fact truncation keep the prompt
    // lean; large fetched artifacts stay in the blackboard for the finalizer.
    let factsPrefix = '';
    try {
      const facts = await knowledgeRag.query(prompt, { k: 5 });
      if (facts.length > 0) {
        factsPrefix = `${'Known facts and guidance (from the shared knowledge store):\n'}${facts
          .map((f) => `- ${truncateFact(f.content, 300)}`)
          .join('\n')}\n\n`;
      }
    } catch {
      // knowledge store unavailable — proceed without the prefix
    }

    const messages: Message[] = [
      {
        role: 'system',
        content: `${this.deps.systemPrompt ?? EXECUTOR_SYSTEM}${taskAnchor}`,
      },
      { role: 'user', content: `${factsPrefix}${prompt}` },
    ];
    const tools: LlmTool[] = [...input.tools];
    let usage = ZERO;
    // Phase 2 identity dedup: remember every (tool, canonical-args) fetched THIS
    // run. A repeat call short-circuits — no MCP round-trip and, crucially, no
    // re-injection of the (often large) payload into the context. The model is
    // told it already has the data instead. Cuts the redundant include re-reads
    // seen live (gi≈34 calls for 6 includes) + the context bloat they cause.
    const fetched = new Set<string>();
    // Counts consecutive unmet-need iterations whose tool re-query surfaced NO
    // new tool. One such "nudge" is allowed (the tool may already be present and
    // the model just needs prompting); a second consecutive no-progress need
    // means the capability is genuinely unavailable → return incomplete instead
    // of looping to maxIterations or passing a half-answer off as ok.
    let noProgressNeeds = 0;

    // Proactive tool seeding: if no tools were supplied by the dispatcher, query
    // toolsRag BEFORE the first LLM call so a capable model that never emits
    // "I can't" still sees the relevant tools from turn 1.
    // ORDER MATTERS: enrich the search text with the knowledge-RAG context
    // (guidance) FIRST, then vectorize THAT for tool discovery. Seeded guidance
    // like "read an include body via GetInclude" must steer which tools surface
    // — querying the bare prompt would never rank GetInclude for a "review
    // program" task, so the model would fall back to the wrong tool. This is the
    // contextual-RAG-then-tool-search ordering.
    if (tools.length === 0) {
      // TWO ADDITIVE single-intent searches, UNIONed — never one mixed query.
      // (1) PROMPT search: the overall intent (taskSpec) + guidance + node prompt
      //     → the main-task tools (e.g. GetProgram for the program shell).
      // (2) NEEDS search: each Evaluator gap ("read the include bodies") queried
      //     SEPARATELY → the specific tool for that gap (GetInclude /
      //     GetIncludesList). Kept separate because a single mixed query DILUTES
      //     and DEMOTES the prompt-driven tools (measured: GetProgram #8 → #18
      //     when needs are mixed in). Single-intent queries each match their tool
      //     cleanly; the union covers both intents without lexical collision.
      const seedQuery = `${taskAnchor ? `${renderTaskSpec(taskSpec as NonNullable<typeof taskSpec>)}\n` : ''}${factsPrefix}${prompt}`;
      const seeded = await toolsRag.query(seedQuery, 10);
      for (const t of seeded) tools.push(t as LlmTool);
      let needSeeded = 0;
      if (input.evaluatorNeeds && input.evaluatorNeeds.length > 0) {
        const have = new Set(tools.map((t) => t.name));
        const byNeeds = await toolsRag.query(
          input.evaluatorNeeds.join('; '),
          10,
        );
        for (const t of byNeeds)
          if (!have.has((t as LlmTool).name)) {
            tools.push(t as LlmTool);
            needSeeded++;
          }
      }
      input.sessionLogger?.logStep('executor_tool_seed', {
        source: ref,
        seededCount: seeded.length,
        needSeededCount: needSeeded,
      });
    }

    // Issue #167: MERGE client-provided external tools (consumer-executed, e.g.
    // create_file / rag_add) with the seeded MCP tools — AFTER seeding, so they
    // never suppress the MCP seed (which only runs when `tools.length === 0`).
    // De-dup by name so a tool present in both sets is offered once.
    if (input.externalTools && input.externalTools.length > 0) {
      const have = new Set(tools.map((t) => t.name));
      for (const t of input.externalTools)
        if (!have.has(t.name)) tools.push(t as LlmTool);
    }

    // Guard 2b — explicit "no capability" error, never a silent hallucination.
    // The trigger is precise: the Evaluator established a NEED for this step
    // (evaluatorNeeds non-empty → it judged the input needs-work and named the
    // missing data/capability), yet every seeding path (input tools, prompt
    // search, the needs search itself, external tools) left the toolset EMPTY.
    // So a need exists and NO tool in RAG can satisfy it — calling the LLM now
    // would fabricate the missing data (the live DAG-on-dead-proxy failure:
    // 0 tools → invented review, promptTokens=1224 vs 507650 with a live proxy).
    // We surface the gap to the consumer instead of returning invented content.
    // NOTE the condition is gated on evaluatorNeeds — a step with NO established
    // need is allowed to answer tool-free (legitimate reasoning); only an UNMET
    // established need is an error. Opt out entirely with deps.allowToolless.
    if (
      tools.length === 0 &&
      !this.deps.allowToolless &&
      (input.evaluatorNeeds?.length ?? 0) > 0
    ) {
      input.sessionLogger?.logStep('executor_no_tools', {
        source: ref,
        reason: 'evaluator established a need but the toolset is empty',
        evaluatorNeeds: input.evaluatorNeeds ?? [],
      });
      throw new ClarifySignal(
        `I cannot complete this task: it requires ${(input.evaluatorNeeds ?? []).join('; ')}, but no tool is available to provide that (the tool subsystem returned an empty set — the MCP connection may be down, or no tool matches). I am stopping rather than inventing an answer.`,
      );
    }

    // Guard 1 — groundedness/hallucination detector (token-based). Track whether
    // the model ever actually called a tool and the size of the context the final
    // answer was produced from. An answer emitted with ZERO tool calls, no seeded
    // facts, and a tiny prompt — while tools WERE offered — is the hallucination
    // signature (answered from the model's prior, not from retrieved data).
    let toolCallsMade = 0;
    let lastPromptTokens = 0;

    for (let iter = 0; iter < maxIterations; iter++) {
      // Gate BEFORE any further work (review R2-F1/R6-F1). The ledger is the
      // SHARED run-wide counter (not a local snapshot). If it is exhausted we
      // refuse to start another LLM round and bubble budget-exhausted — this
      // is the gate that the budget-extension ClarifySignal depends on: it
      // fires only when MORE work is wanted but the budget is gone. A clean
      // final answer (below) that completes the task returns ok even if its
      // own call nudged the ledger negative — that bounded overshoot is the
      // documented soft cap; there is nothing left to "extend", so no clarify.
      if (budget.tokens.exhausted()) {
        return { status: 'budget-exhausted', usage };
      }
      onProgress?.({
        kind: 'llm-call-start',
        source: ref,
        component,
        model: llm.model ?? 'unknown',
      });
      const res = await llm.chat(messages, tools, { signal });
      onProgress?.({
        kind: 'llm-call-end',
        source: ref,
        component,
        durationMs: 0,
      });
      if (res.ok === false)
        return {
          status: 'incomplete',
          missing: [res.error?.message ?? 'llm error'],
          usage,
        };
      const v = res.value;
      usage = add(usage, v.usage);
      if (v.usage) lastPromptTokens = v.usage.promptTokens;
      if (v.usage) {
        budget.tokens.spend(v.usage); // decrement the shared ledger immediately
        onProgress?.({
          kind: 'tokens-used',
          source: ref,
          component,
          delta: v.usage,
        });
      }

      const toolCalls = v.toolCalls ?? [];
      if (toolCalls.length > 0) {
        toolCallsMade += toolCalls.length;
        // Relay the assistant turn WITH its tool_calls, then one tool message
        // per call carrying the matching tool_call_id. Anthropic/SAP AI SDK (and
        // the DeepSeek/OpenAI protocol) reject a `tool` message that does not
        // follow an assistant `tool_calls` with the same id — an orphaned
        // tool_result is a hard 400. (Mirrors the 17.0 tool-loop wire shape.)
        messages.push({
          role: 'assistant',
          content: v.content || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments ?? {}),
            },
          })),
        });
        for (const tc of toolCalls) {
          const toolName = tc.name;
          const identityKey = artifactIdentityKey(toolName, tc.arguments ?? {});
          // Already fetched THIS run → do NOT re-call MCP and do NOT re-inject the
          // payload; reply with a short note so the model stops re-requesting it
          // (the full result is already earlier in this conversation + the store).
          if (fetched.has(identityKey)) {
            input.sessionLogger?.logStep('executor_fetch_dedup', {
              source: ref,
              scope: 'in-loop',
              tool: toolName,
              identityKey,
            });
            messages.push({
              role: 'tool',
              content: `(Already retrieved ${toolName} with these exact arguments earlier in this run — reuse the prior result above; do not fetch it again.)`,
              tool_call_id: tc.id,
            });
            continue;
          }
          // CROSS-step dedup: another step already fetched this exact artefact
          // into the shared session store. Inject the STORED content (it is NOT
          // in this executor's history) instead of re-calling the tool. No
          // mcp-call, no duplicate write.
          if (knowledgeRag.hasArtifact && knowledgeRag.getArtifact) {
            let priorContent: string | undefined;
            try {
              if (await knowledgeRag.hasArtifact(identityKey))
                priorContent = await knowledgeRag.getArtifact(identityKey);
            } catch {
              // store unavailable → fall through to a live fetch
            }
            if (priorContent !== undefined) {
              fetched.add(identityKey);
              input.sessionLogger?.logStep('executor_fetch_dedup', {
                source: ref,
                scope: 'cross-step',
                tool: toolName,
                identityKey,
              });
              messages.push({
                role: 'tool',
                content: priorContent,
                tool_call_id: tc.id,
              });
              continue;
            }
          }
          onProgress?.({
            kind: 'mcp-call',
            source: ref,
            tool: toolName,
            args: tc.arguments,
          });
          const result = await callMcp(toolName, tc.arguments, signal);
          fetched.add(identityKey);
          onProgress?.({
            kind: 'mcp-result',
            source: ref,
            tool: toolName,
            durationMs: 0,
            bytes: result.length,
          });
          await knowledgeRag.write({
            content: result,
            metadata: {
              traceId: identity.traceId,
              turnId: identity.turnId,
              stepperId: identity.stepperId,
              parentStepperId: identity.parentStepperId,
              task: prompt,
              artifactType: 'mcp-result',
              toolName,
              identityKey,
              createdAt: nowIso(),
            },
          });
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id,
          });
        }
        noProgressNeeds = 0; // a tool call is progress — reset the no-new-tool gate
        continue;
      }

      // No tool call → this answer is a CANDIDATE final answer. ALWAYS analyze
      // it (gated by the resolver/classifier) for an unmet-tool need. The gate
      // is the resolver's verdict — NOT "did toolsRag return anything": a query
      // over a complete answer almost always has near neighbours, so gating on
      // results would false-positive. We re-query ONLY when the classifier says
      // the model expressed a need.
      const need = needResolver
        ? await needResolver.resolve(v.content ?? '')
        : undefined;
      if (need?.queryToolsRag) {
        const found = await toolsRag.query(need.queryToolsRag, 5);
        const have = new Set(tools.map((t) => t.name));
        let added = 0;
        for (const t of found)
          if (!have.has(t.name)) {
            tools.push(t as LlmTool);
            added++;
          }
        if (added === 0) {
          // Re-query surfaced nothing new. Allow a few nudges (the tool may
          // already be present); once the cap is hit the capability is genuinely
          // unavailable → escalate to the CONSUMER (18.1) rather than returning a
          // silent partial: analyze → find tools → add → retry exhausted, so ask.
          const cap = Math.max(1, this.deps.maxNoProgressNeeds ?? 2);
          if (++noProgressNeeds >= cap) {
            throw new ClarifySignal(
              `I could not complete the task: I still need to ${need.queryToolsRag}, and no available tool provides that capability.`,
            );
          }
        } else {
          noProgressNeeds = 0;
        }
        messages.push({ role: 'assistant', content: v.content ?? '' });
        messages.push({
          role: 'user',
          content: `You now have additional tools available. ${prompt}`,
        });
        continue;
      }

      // Guard 1 — flag a likely hallucination BEFORE accepting the answer. The
      // model produced a final answer without ever calling a tool, with no seeded
      // facts to ground it, while tools WERE on offer — and the answer-producing
      // call ingested only a small prompt (no retrieved data). That is content
      // generated from the model's prior, not from this session's sources. We do
      // not hard-fail (a legitimately tool-free answer is possible) but we emit a
      // structured, token-backed signal so the coordinator/consumer can audit it.
      if (toolCallsMade === 0 && factsPrefix === '' && tools.length > 0) {
        input.sessionLogger?.logStep('hallucination_suspected', {
          source: ref,
          reason:
            'final answer produced with no tool calls and no grounding facts',
          toolsOffered: tools.length,
          toolCallsMade,
          finalPromptTokens: lastPromptTokens,
          answerChars: (v.content ?? '').length,
        });
      }

      // Clean final answer → write + return ok.
      await knowledgeRag.write({
        content: v.content ?? '',
        metadata: {
          traceId: identity.traceId,
          turnId: identity.turnId,
          stepperId: identity.stepperId,
          parentStepperId: identity.parentStepperId,
          task: prompt,
          artifactType: 'analysis-finding',
          createdAt: nowIso(),
        },
      });
      return { status: 'ok', usage };
    }
    return { status: 'incomplete', missing: ['max iterations reached'], usage };
  }
}

// Injectable clock kept out of the hot path; callers in deterministic test
// contexts can monkeypatch if needed. ISO string only used for ordering.
function nowIso(): string {
  return new Date().toISOString();
}

/** Keep blackboard facts short in the executor prompt — guidance entries are
 *  brief and survive intact; large fetched artifacts are truncated (the full
 *  copy stays in the knowledge store for the finalizer's exhaustive list). */
function truncateFact(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
