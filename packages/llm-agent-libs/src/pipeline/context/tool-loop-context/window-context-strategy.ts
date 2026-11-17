import type {
  IToolLoopContextStrategy,
  Message,
  SerializableStrategyState,
  ToolLoopContextBase,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';

export interface WindowContextStrategyOptions {
  keepLastRounds?: number;
}

/** Preserve every round unless the consumer explicitly opts into a tool window. */
export class WindowContextStrategy implements IToolLoopContextStrategy {
  private rounds: ToolRound[] = [];
  private readonly keep: number | undefined;

  constructor(opts: WindowContextStrategyOptions = {}) {
    this.keep =
      opts.keepLastRounds === undefined
        ? undefined
        : Math.max(1, opts.keepLastRounds);
  }

  async record(round: ToolRound): Promise<void> {
    this.rounds.push(round);
  }

  async form(base: ToolLoopContextBase): Promise<Message[]> {
    const out: Message[] = [...base.prefix];
    const tailStart =
      this.keep === undefined ? 0 : Math.max(0, this.rounds.length - this.keep);
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

  restore(state: SerializableStrategyState): void {
    this.rounds =
      state?.version === 1 &&
      Array.isArray((state as { rounds?: unknown }).rounds)
        ? (state as unknown as { rounds: ToolRound[] }).rounds
        : [];
  }
}
