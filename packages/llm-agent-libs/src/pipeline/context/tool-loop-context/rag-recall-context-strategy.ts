import type {
  CallOptions,
  IToolLoopContextStrategy,
  Message,
  SerializableStrategyState,
  ToolLoopContextBase,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';
import { toModelToolMessage } from '@mcp-abap-adt/llm-agent';

export interface RagRecallDeps {
  record(round: ToolRound, options?: CallOptions): Promise<void>;
  /** Return rounds of named raw results for trust projection; strings are legacy preformatted context. */
  recall(
    queryText: string,
    excludeRoundIds: string[],
    options?: CallOptions,
  ): Promise<
    | string
    | {
        rounds: Array<Array<{ toolName?: string; content: string }>>;
        maxChars?: number;
      }
  >;
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
    if (typeof block === 'string') {
      if (block) out.push({ role: 'user', content: block });
    } else {
      let remaining = block.maxChars ?? Number.POSITIVE_INFINITY;
      const parts: string[] = [];
      for (const round of block.rounds) {
        const raw = round.map((result) => result.content).join('\n');
        if (!raw.length) continue;
        const truncated = raw.length > remaining;
        const content = truncated ? raw.slice(0, remaining) : raw;
        if (!base.toolTrust) {
          parts.push(content);
        } else {
          // Slice raw round text first: trust tags never consume the budget.
          const projected: string[] = [];
          let offset = 0;
          for (const [index, result] of round.entries()) {
            if (index > 0) {
              if (offset >= content.length) break;
              projected.push('\n');
              offset++;
            }
            if (offset >= content.length && result.content.length > 0) break;
            projected.push(
              String(
                toModelToolMessage(
                  {
                    role: 'tool',
                    content: content.slice(
                      offset,
                      offset + result.content.length,
                    ),
                  },
                  base.toolTrust,
                  result.toolName,
                ).content,
              ),
            );
            offset += result.content.length;
          }
          parts.push(projected.join(''));
        }
        if (truncated) break;
        remaining -= raw.length;
      }
      if (parts.length)
        out.push({
          role: 'user',
          content: `Relevant prior context:\n${parts.join('\n')}`,
        });
    }
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
