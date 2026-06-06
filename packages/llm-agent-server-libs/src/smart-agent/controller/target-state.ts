import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { ClarifySignal } from '@mcp-abap-adt/llm-agent';
import type { ISubagentClient } from './subagent-client.js';
import type { ControllerConfig } from './types.js';

export interface TargetStateDeps {
  evaluator: ISubagentClient;
  embedder: IEmbedder;
}

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
): Promise<string> {
  const r = await deps.evaluator.send([
    {
      role: 'system',
      content: 'Formulate a concise target state (goal) for the user prompt.',
    },
    { role: 'user', content: prompt },
  ]);
  const target = r.kind === 'content' ? r.content : '';

  if (cfg.strategy === 'consumer-confirm') {
    throw new ClarifySignal(`Confirm or refine the target state:\n${target}`);
  }

  // MVP: 'auto' currently behaves as 'semantic-distance' (evaluator-self-judging is a follow-up).
  if (cfg.strategy === 'semantic-distance' || cfg.strategy === 'auto') {
    const [te, pe] = await Promise.all([
      deps.embedder.embed(target),
      deps.embedder.embed(prompt),
    ]);
    const dist = cosineDistance(te.vector, pe.vector);
    if (dist > cfg.distanceThreshold) {
      throw new ClarifySignal(
        'The goal may be ambiguous (distance ' +
          dist.toFixed(2) +
          '). Confirm or refine:\n' +
          target,
      );
    }
  }

  return target;
}
