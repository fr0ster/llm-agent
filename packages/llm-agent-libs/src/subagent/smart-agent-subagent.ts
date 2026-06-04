import {
  externalToolCallId,
  type ISubAgent,
  type ISubAgentInput,
  type ISubAgentResult,
  type LlmToolCall,
  type SubAgentCapabilities,
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
      onPartial: input.onPartial,
      // Issue #167: forward the client's external (consumer-executed) tools into
      // the worker's nested pipeline so it can emit a tool call the client
      // fulfils, instead of narrating "tool unavailable".
      ...(input.externalTools && input.externalTools.length > 0
        ? { externalTools: [...input.externalTools] }
        : {}),
      // #171 (review#7): thread the validated extId→result map into the
      // worker pipeline so a re-surfaced external call resolves from history.
      ...(input.externalResults
        ? { externalResults: input.externalResults }
        : {}),
    });

    if (!res.ok) {
      throw res.error;
    }

    const { content, toolCalls, stopReason, usage } = res.value;

    const mappedUsage = usage
      ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        }
      : undefined;

    // Issue #171: when the worker tool-loop stops on a client-provided
    // (consumer-executed) external tool call, it surfaces the call instead of
    // executing it. Translate that stop into a typed awaiting-external result
    // with deterministic `ext:` ids the client can correlate. Internal MCP
    // calls are executed inside the worker loop and never reach here.
    if (stopReason === 'tool_calls' && toolCalls && toolCalls.length > 0) {
      const extNames = new Set((input.externalTools ?? []).map((t) => t.name));
      const pending: LlmToolCall[] = toolCalls
        .filter((tc) => extNames.has(tc.function.name))
        .map((tc) => {
          const args = JSON.parse(tc.function.arguments) as Record<
            string,
            unknown
          >;
          return {
            id: externalToolCallId(tc.function.name, args),
            name: tc.function.name,
            arguments: args,
          };
        });
      if (pending.length > 0) {
        return {
          output: content,
          usage: mappedUsage,
          status: 'awaiting-external',
          pendingExternalToolCalls: pending,
        };
      }
    }

    const mappedToolCalls: LlmToolCall[] | undefined = toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    return {
      output: content,
      toolCalls: mappedToolCalls,
      usage: mappedUsage,
      status: 'complete',
    };
  }
}
