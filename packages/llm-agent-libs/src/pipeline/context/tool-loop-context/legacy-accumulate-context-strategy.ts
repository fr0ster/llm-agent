import type {
  IToolLoopContextStrategy,
  Message,
  SerializableStrategyState,
  ToolLoopContextBase,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';

/** Library default — reproduces today's growing transcript byte-identically. */
export class LegacyAccumulateContextStrategy
  implements IToolLoopContextStrategy
{
  private rounds: ToolRound[] = [];

  async record(round: ToolRound): Promise<void> {
    this.rounds.push(round);
  }

  async form(base: ToolLoopContextBase): Promise<Message[]> {
    const out: Message[] = [...base.prefix];
    for (const r of this.rounds) {
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
