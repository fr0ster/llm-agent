import {
  ClarifySignal,
  type IExecutor,
  type INeedResolver,
  type LlmComponent,
  type LlmTool,
  type LlmUsage,
  type Message,
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
      toolSafety,
      signal,
      onProgress,
    } = input;
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
      { role: 'system', content: EXECUTOR_SYSTEM },
      { role: 'user', content: `${factsPrefix}${prompt}` },
    ];
    const tools: LlmTool[] = [...input.tools];
    let usage = ZERO;
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
      const seedQuery = factsPrefix ? `${factsPrefix}${prompt}` : prompt;
      const seeded = await toolsRag.query(seedQuery, 10);
      for (const t of seeded) tools.push(t as LlmTool);
      input.sessionLogger?.logStep('executor_tool_seed', {
        source: ref,
        seededCount: seeded.length,
      });
    }

    const isReadOnly = (toolName: string): boolean => {
      const t = toolsRag.lookup(toolName) as
        | (LlmTool & { readOnly?: boolean })
        | undefined;
      if (t?.readOnly === true) return true;
      if (toolSafety.knownReadOnlyTools.has(toolName)) return true;
      return toolSafety.mutationPolicy === 'trusted';
    };

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
          if (!isReadOnly(toolName)) {
            throw new ClarifySignal(
              `about to call ${toolName}(${JSON.stringify(tc.arguments)}); this tool is not declared read-only — proceed?`,
            );
          }
          onProgress?.({
            kind: 'mcp-call',
            source: ref,
            tool: toolName,
            args: tc.arguments,
          });
          const result = await callMcp(toolName, tc.arguments, signal);
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
          // Re-query surfaced nothing new. Allow one nudge (tool may already be
          // present); on a second consecutive no-progress need, the capability
          // is genuinely unavailable — stop honestly.
          if (++noProgressNeeds >= 2) {
            return {
              status: 'incomplete',
              missing: [need.queryToolsRag],
              usage,
            };
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
