import type {
  CallOptions,
  IToolLoopContextStrategy,
  Message,
  SerializableStrategyState,
  ToolLoopContextBase,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';

export interface RagRecallDeps {
  record(round: ToolRound, options?: CallOptions): Promise<void>;
  recall(
    queryText: string,
    excludeRoundIds: string[],
    options?: CallOptions,
  ): Promise<string>;
}
export interface RagRecallStrategyRunDeps {
  runId: string;
}

/** Generic RAG-managed strategy. Results are durable in the consumer's RAG; only
 *  the most-recent round is held in memory (the raw tail). */
export class RagRecallContextStrategy implements IToolLoopContextStrategy {
  private last: ToolRound | null = null;
  private counter = 0;
  private readonly runId: string;

  constructor(
    private readonly deps: RagRecallDeps,
    run: RagRecallStrategyRunDeps,
  ) {
    if (!run?.runId) {
      throw new Error('RagRecallContextStrategy requires a non-empty runId');
    }
    this.runId = run.runId;
  }

  async record(round: ToolRound, options?: CallOptions): Promise<void> {
    if (!round.roundId) round.roundId = `${this.runId}:${this.counter}`;
    this.counter++;
    await this.deps.record(round, options);
    this.last = round;
  }

  async form(
    base: ToolLoopContextBase,
    options?: CallOptions,
  ): Promise<Message[]> {
    if (this.last === null) return [...base.prefix];
    const queryText = base.queryText ?? '';
    const out: Message[] = [...base.prefix];
    const block = await this.deps.recall(
      queryText,
      [this.last.roundId as string],
      options,
    );
    if (block) out.push({ role: 'user', content: block });
    out.push(this.last.assistant, ...this.last.results);
    return out;
  }

  snapshot(): SerializableStrategyState {
    return {
      version: 1,
      last: (this.last as unknown as never) ?? null,
      counter: this.counter,
    };
  }

  restore(state: SerializableStrategyState): void {
    if (state?.version === 1) {
      this.last = (state as unknown as { last: ToolRound | null }).last ?? null;
      this.counter = Number(
        (state as unknown as { counter?: number }).counter ?? 0,
      );
    } else {
      this.last = null;
      this.counter = 0;
    }
  }
}
