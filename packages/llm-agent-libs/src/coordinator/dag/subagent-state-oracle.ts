import type {
  IStateOracle,
  ISubAgent,
  StateOracleInput,
  StateOracleResult,
} from '@mcp-abap-adt/llm-agent';

/** Exposes a subagent's answer and call records as a state-oracle result. */
export class SubAgentStateOracle implements IStateOracle {
  constructor(private readonly inner: ISubAgent) {}

  get name(): string {
    return this.inner.name;
  }

  async query(input: StateOracleInput): Promise<StateOracleResult> {
    const res = await this.inner.run({
      caller: input.caller,
      task: input.query,
      sessionId: input.sessionId,
      usage: input.usage?.with({ role: 'oracle' }),
      signal: input.signal,
      trace: input.trace,
      requestLogger: input.requestLogger,
      sessionLogger: input.sessionLogger,
    });
    return {
      answer: res.output,
      usage: res.usage,
      usageByModel: res.usage?.models,
      usageCalls: res.usageCalls,
      model: res.model ?? this.inner.model,
    };
  }
}
