import type {
  IStateOracle,
  ISubAgent,
  StateOracleInput,
  StateOracleResult,
} from '@mcp-abap-adt/llm-agent';

/**
 * Adapter wrapping a raw ISubAgent as an IStateOracle. The wrapped
 * subagent runs a full pipeline whose LLM activity is logged by its
 * own handlers under their own component labels (`tool-loop`,
 * `classifier`, …) via the SHARED session requestLogger keyed on the
 * forwarded traceId. To avoid double-counting, this adapter
 * intentionally returns `usage: undefined`; the handler's
 * `logRoleUsage('oracle', …)` is therefore a no-op for subagent-backed
 * oracles. A pure-LLM IStateOracle implementation that bypasses
 * pipeline logging would populate `usage` normally.
 */
export class SubAgentStateOracle implements IStateOracle {
  constructor(private readonly inner: ISubAgent) {}

  get name(): string {
    return this.inner.name;
  }

  async query(input: StateOracleInput): Promise<StateOracleResult> {
    const res = await this.inner.run({
      task: input.query,
      sessionId: input.sessionId,
      signal: input.signal,
      trace: input.trace,
      sessionLogger: input.sessionLogger,
    });
    return { answer: res.output, usage: undefined };
  }
}
