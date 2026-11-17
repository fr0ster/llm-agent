import type { Message, ToolRound } from '@mcp-abap-adt/llm-agent';

type RoundMessage = Message & { toolLoopRoundOrdinal?: number };

/** Retain validation exchanges at their original position between tool rounds. */
export class ToolLoopControlHistory {
  constructor(private readonly prefixLength = 0) {}

  private ordinal = 0;
  private initialized = false;
  private readonly restoredToolCallIds = new Set<string>();
  private readonly exchanges: Array<{
    precedingOrdinal: number;
    messages: Message[];
  }> = [];

  /** Carry a run-local identity through strategy copies, independently of call IDs. */
  record(round: ToolRound): ToolRound {
    const ordinal = ++this.ordinal;
    const tag = (message: Message): RoundMessage => ({
      ...message,
      toolLoopRoundOrdinal: ordinal,
    });
    return {
      ...round,
      ordinal,
      assistant: tag(round.assistant),
      results: round.results.map(tag),
    };
  }

  append(messages: Message[]): void {
    this.exchanges.push({ precedingOrdinal: this.ordinal, messages });
  }

  restore(formed: Message[]): Message[] {
    if (!this.initialized) {
      // A restored snapshot can retain ordinals from the previous run.
      formed.forEach((message: RoundMessage) => {
        this.ordinal = Math.max(
          this.ordinal,
          message.toolLoopRoundOrdinal ?? 0,
        );
      });
      // Older snapshots have no ordinal tags; retain their completed-round anchors.
      for (const message of formed.slice(this.prefixLength)) {
        if (message.role === 'tool' && message.tool_call_id !== undefined) {
          this.restoredToolCallIds.add(message.tool_call_id);
        }
      }
      this.initialized = true;
    }
    const out = formed.concat();
    let earliest = Math.min(this.prefixLength, formed.length);
    for (const exchange of this.exchanges) {
      // If a strategy elides the predecessor, fall back before newer rounds.
      // An earlier restored exchange remains a lower bound for insertion.
      let insertAt = earliest;
      for (let index = out.length - 1; index >= earliest; index--) {
        const message: RoundMessage = out[index];
        const ordinal = message.toolLoopRoundOrdinal;
        if (
          (ordinal !== undefined && ordinal <= exchange.precedingOrdinal) ||
          (ordinal === undefined &&
            message.role === 'tool' &&
            message.tool_call_id !== undefined &&
            this.restoredToolCallIds.has(message.tool_call_id))
        ) {
          insertAt = index + 1;
          break;
        }
      }
      out.splice(insertAt, 0, ...exchange.messages);
      earliest = insertAt + exchange.messages.length;
    }
    // Internal provenance must never cross the model boundary.
    return out.map((message: RoundMessage): Message => {
      if (message.toolLoopRoundOrdinal === undefined) return message;
      const { toolLoopRoundOrdinal: _ordinal, ...raw } = message;
      return raw;
    });
  }
}
