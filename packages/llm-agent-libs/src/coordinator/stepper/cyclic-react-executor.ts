import {
  ClarifySignal,
  type IExecutor,
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
}

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
      needResolver,
      budget,
      identity,
      toolSafety,
      signal,
      onProgress,
    } = input;
    const ref = {
      stepperId: identity.stepperId,
      parentStepperId: identity.parentStepperId,
      name: this.name,
    };

    const messages: Message[] = [{ role: 'user', content: prompt }];
    const tools: LlmTool[] = [...input.tools];
    let usage = ZERO;

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
        messages.push({ role: 'assistant', content: v.content ?? '' });
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
          messages.push({ role: 'tool', content: result });
        }
        continue;
      }

      // No tool call. Either a clean final answer, or a "need" utterance.
      const need = needResolver
        ? await needResolver.resolve(v.content ?? '')
        : undefined;
      if (need?.queryToolsRag) {
        const found = await toolsRag.query(need.queryToolsRag, 5);
        // inject any newly-discovered tools the model didn't have yet
        const have = new Set(tools.map((t) => t.name));
        for (const t of found) if (!have.has(t.name)) tools.push(t as LlmTool);
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
