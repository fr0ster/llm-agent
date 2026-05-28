import type {
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  LlmToolCall,
  SubAgentCapabilities,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../agent.js';

export class SmartAgentSubAgent implements ISubAgent {
  public readonly description?: string;
  public readonly capabilities: SubAgentCapabilities = {
    contextPolicy: 'optional',
  };

  constructor(
    public readonly name: string,
    private readonly agent: SmartAgent,
    opts?: { description?: string },
  ) {
    this.description = opts?.description;
  }

  async run(input: ISubAgentInput): Promise<ISubAgentResult> {
    const prompt =
      input.context && input.context.length > 0
        ? `${input.context}\n\n${input.task}`
        : input.task;
    const res = await this.agent.process(prompt, {
      sessionId: input.sessionId,
      signal: input.signal,
      trace: input.trace,
      sessionLogger: input.sessionLogger,
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
