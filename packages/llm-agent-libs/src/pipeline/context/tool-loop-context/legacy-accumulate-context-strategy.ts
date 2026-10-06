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
        `tool-loop context (legacy-accumulate): saved state of version ${String(state.version)} cannot be restored`,
        PIPELINE_FAILURE_CODES.STATE_CORRUPT,
      );
    }
    this.rounds = state.rounds as unknown as ToolRound[];
  }
}
