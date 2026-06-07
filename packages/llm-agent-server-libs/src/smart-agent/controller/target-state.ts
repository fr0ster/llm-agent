import type { IEmbedder, LlmUsage } from '@mcp-abap-adt/llm-agent';
import type { ISubagentClient } from './subagent-client.js';
import type { ControllerConfig } from './types.js';

export interface TargetStateDeps {
  evaluator: ISubagentClient;
  /** Required only for distance strategies (semantic-distance/auto). */
  embedder?: IEmbedder;
}

/**
 * Outcome of establishing the target state. `established` → the goal is settled
 * and the loop proceeds. `needs-confirmation` → the coordinator must ask the
 * consumer to confirm/refine `proposedTarget` (the marker carries it so a plain
 * "yes" on resume commits the proposed target rather than the literal answer).
 */
export type TargetStateOutcome =
  | { kind: 'established'; goal: string; usage?: LlmUsage }
  | {
      kind: 'needs-confirmation';
      proposedTarget: string;
      question: string;
      usage?: LlmUsage;
    };

function cosineDistance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function establishTargetState(
  deps: TargetStateDeps,
  prompt: string,
  cfg: ControllerConfig['targetState'],
): Promise<TargetStateOutcome> {
  const r = await deps.evaluator.send([
    {
      role: 'system',
      content:
        'Restate the user request as a SHORT objective — the target state to ' +
        'achieve — in one or two sentences. Do NOT answer the request, and do ' +
        'NOT include any data, results, code, or explanations. Output only the ' +
        'objective.',
    },
    { role: 'user', content: prompt },
  ]);
  const target = r.kind === 'content' ? r.content : '';

  if (cfg.strategy === 'consumer-confirm') {
    return {
      kind: 'needs-confirmation',
      proposedTarget: target,
      question: `Confirm or refine the target state:\n${target}`,
      usage: r.usage,
    };
  }

  // MVP: 'auto' currently behaves as 'semantic-distance' (evaluator-self-judging is a follow-up).
  if (cfg.strategy === 'semantic-distance' || cfg.strategy === 'auto') {
    if (!deps.embedder) {
      throw new Error(
        `target-state strategy '${cfg.strategy}' requires an embedder; configure rag.embedder or use strategy: consumer-confirm`,
      );
    }
    const [te, pe] = await Promise.all([
      deps.embedder.embed(target),
      deps.embedder.embed(prompt),
    ]);
    const dist = cosineDistance(te.vector, pe.vector);
    if (dist > cfg.distanceThreshold) {
      return {
        kind: 'needs-confirmation',
        proposedTarget: target,
        question: `The goal may be ambiguous (distance ${dist.toFixed(2)}). Confirm or refine:\n${target}`,
        usage: r.usage,
      };
    }
  }

  return { kind: 'established', goal: target, usage: r.usage };
}
