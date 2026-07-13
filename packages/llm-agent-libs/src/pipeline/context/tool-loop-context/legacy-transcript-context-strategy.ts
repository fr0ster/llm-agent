import type {
  IToolLoopContextStrategy,
  Message,
  SerializableStrategyState,
  ToolLoopContextBase,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';

/** MIGRATION-ONLY: holds a pre-release raw transcript (arbitrary Message[]) that
 *  cannot be expressed as ToolRound[]. Never injected as a factory. */
export class LegacyTranscriptContextStrategy
  implements IToolLoopContextStrategy
{
  private rawMessages: Message[];
  private newRounds: ToolRound[] = [];

  constructor(opts: { rawMessages: Message[] }) {
    this.rawMessages = [...opts.rawMessages];
  }

  async record(round: ToolRound): Promise<void> {
    this.newRounds.push(round);
  }

  async form(base: ToolLoopContextBase): Promise<Message[]> {
    const out: Message[] = [...base.prefix, ...this.rawMessages];
    for (const r of this.newRounds) out.push(r.assistant, ...r.results);
    return out;
  }

  snapshot(): SerializableStrategyState {
    return {
      version: 1,
      rawMessages: this.rawMessages as unknown as never,
      newRounds: this.newRounds as unknown as never,
    };
  }

  restore(state: SerializableStrategyState): void {
    if (state?.version === 1) {
      this.rawMessages =
        (state as unknown as { rawMessages?: Message[] }).rawMessages ?? [];
      this.newRounds =
        (state as unknown as { newRounds?: ToolRound[] }).newRounds ?? [];
    }
  }
}
