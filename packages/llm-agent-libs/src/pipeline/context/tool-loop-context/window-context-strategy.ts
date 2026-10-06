import type {
  IToolLoopContextStrategy,
  Message,
  SerializableStrategyState,
  ToolLoopContextBase,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';
import {
  OrchestratorError,
  PIPELINE_FAILURE_CODES,
} from '@mcp-abap-adt/llm-agent';

export interface WindowContextStrategyOptions {
  keepLastRounds?: number;
}

/** RAG-less bounded window: last K rounds raw + one marker for the rest. */
export class WindowContextStrategy implements IToolLoopContextStrategy {
  private rounds: ToolRound[] = [];
  private readonly keep: number;

  constructor(opts: WindowContextStrategyOptions = {}) {
    this.keep = Math.max(1, opts.keepLastRounds ?? 3);
  }

  async record(round: ToolRound): Promise<void> {
    this.rounds.push(round);
  }

  async form(base: ToolLoopContextBase): Promise<Message[]> {
    const out: Message[] = [...base.prefix];
    const tailStart = Math.max(0, this.rounds.length - this.keep);
    const elided = this.rounds.slice(0, tailStart);
    if (elided.length > 0) {
      const chars = elided.reduce(
        (n, r) =>
          n + r.results.reduce((m, x) => m + String(x.content ?? '').length, 0),
        0,
      );
      out.push({
        role: 'user',
        content: `[${elided.length} earlier tool result(s) elided — ${chars} chars]`,
      });
    }
    for (const r of this.rounds.slice(tailStart)) {
      out.push(r.assistant, ...r.results);
    }
    return out;
  }

  snapshot(): SerializableStrategyState {
    return { version: 1, rounds: this.rounds as unknown as never };
  }

  /**
   * No saved state starts empty (absent by design); a state of another version
   * or of the wrong shape is `STATE_CORRUPT` — never a silent reset (spec D70).
   */
  restore(state: SerializableStrategyState): void {
    if (state === undefined) {
      this.rounds = [];
      return;
    }
    if (state.version !== 1 || !Array.isArray(state.rounds)) {
      throw new OrchestratorError(
        `tool-loop context (window): saved state of version ${String(state.version)} cannot be restored`,
        PIPELINE_FAILURE_CODES.STATE_CORRUPT,
      );
    }
    this.rounds = state.rounds as unknown as ToolRound[];
  }
}
