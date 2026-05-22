import type {
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  LlmToolCall,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../agent.js';

export class SmartAgentSubAgent implements ISubAgent {
  public readonly description?: string;

  constructor(
    public readonly name: string,
    private readonly agent: SmartAgent,
    opts?: { description?: string },
  ) {
    this.description = opts?.description;
  }

  async run(input: ISubAgentInput): Promise<ISubAgentResult> {
    const res = await this.agent.process(input.task, {
      sessionId: input.sessionId,
      signal: input.signal,
    });

    if (!res.ok) {
      throw res.error;
    }

    const { content, toolCalls, usage } = res.value;

    const mappedToolCalls: LlmToolCall[] | undefined = toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    return {
      output: content,
      toolCalls: mappedToolCalls,
      usage: usage
        ? {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          }
        : undefined,
    };
  }
}
