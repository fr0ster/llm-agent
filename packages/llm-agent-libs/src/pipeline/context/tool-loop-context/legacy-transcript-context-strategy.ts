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

  /**
   * No saved state starts empty (absent by design); a state of another version
   * or of the wrong shape is `STATE_CORRUPT` — never ignored (spec D92).
   */
  restore(state: SerializableStrategyState): void {
    if (state === undefined) {
      this.rawMessages = [];
      this.newRounds = [];
      return;
    }
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      throw new OrchestratorError(
        'tool-loop context (legacy-transcript): saved state is not an object',
        PIPELINE_FAILURE_CODES.STATE_CORRUPT,
      );
    }
    const s = state as unknown as {
      rawMessages?: unknown;
      newRounds?: unknown;
    };
    if (
      state.version !== 1 ||
      !Array.isArray(s.rawMessages) ||
      !Array.isArray(s.newRounds)
    ) {
      throw new OrchestratorError(
        `tool-loop context (legacy-transcript): saved state of version ${String(state.version)} cannot be restored`,
        PIPELINE_FAILURE_CODES.STATE_CORRUPT,
      );
    }
    this.rawMessages = s.rawMessages as Message[];
    this.newRounds = s.newRounds as ToolRound[];
  }
}
