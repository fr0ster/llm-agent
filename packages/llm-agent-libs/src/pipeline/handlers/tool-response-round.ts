import { randomUUID } from 'node:crypto';
import type {
  JsonValue,
  LlmToolCall,
  Message,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';

/** Only JSON objects are valid tool arguments. Never execute a decoding fallback. */
export function parseToolArguments(
  raw: string,
): LlmToolCall['arguments'] | undefined {
  try {
    const value: JsonValue = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

type ToolResultMeta = { identityKey?: string; isError?: boolean };
const invalidArguments = 'Invalid tool arguments: expected a JSON object.';

/** One model response owns one ordered, complete conversation exchange. */
export class ToolResponseRound {
  readonly assistant: Message;
  readonly calls: Array<{ id: string; name: string; arguments: string }>;
  private readonly rejectedCalls: Array<{
    id: string;
    name: string;
    argumentLength: number;
    reason: string;
  }> = [];
  private readonly resolutions = new Map<
    string,
    {
      message: Message;
      meta: ToolResultMeta;
    }
  >();

  constructor(
    content: string | null,
    calls: Iterable<{
      name: string;
      arguments: string;
    }>,
    isExternal: (name: string) => boolean = () => false,
    historicalIds?: readonly string[],
  ) {
    const roundId = randomUUID();
    let externalIndex = 0;
    // Provider IDs identify stream fragments only. History and execution use
    // our IDs, including when the model repeats or omits IDs within a round.
    // Replaying stored records preserves their stable IDs when available.
    this.calls = Array.from(calls, (call, index) => ({
      id:
        historicalIds?.[index] ||
        (isExternal(call.name)
          ? `ext:${roundId}:${externalIndex++}`
          : `tc:${roundId}:${index}`),
      name: call.name,
      arguments: call.arguments,
    }));
    this.assistant = {
      role: 'assistant',
      content: content || null,
      tool_calls: this.calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }

  resolve(
    call: Pick<LlmToolCall, 'id'>,
    content: string,
    isError = false,
  ): void {
    this.add({ role: 'tool', tool_call_id: call.id, content }, { isError });
  }

  /** Resolve malformed declarations as errors and return only executable calls. */
  executableCalls(): LlmToolCall[] {
    return this.calls.flatMap((call) => {
      const args = parseToolArguments(call.arguments);
      if (args !== undefined) return [{ ...call, arguments: args }];
      this.rejectedCalls.push({
        id: call.id,
        name: call.name,
        argumentLength: call.arguments.length,
        reason: invalidArguments,
      });
      this.resolve(
        call,
        `Error: ${invalidArguments} Retry this tool with a complete, valid JSON object.`,
        true,
      );
      return [];
    });
  }

  diagnostics(executable: readonly LlmToolCall[]) {
    return {
      receivedToolCalls: this.calls.map(({ id, name, arguments: args }) => ({
        id,
        name,
        argumentLength: args.length,
      })),
      rejectedToolCalls: this.rejectedCalls,
      executableToolCalls: executable.map(({ id, name }) => ({ id, name })),
    };
  }

  add(message: Message, meta: ToolResultMeta): void {
    if (
      !message.tool_call_id ||
      !this.assistant.tool_calls?.some(
        (call) => call.id === message.tool_call_id,
      ) ||
      this.resolutions.has(message.tool_call_id)
    ) {
      throw new Error('A tool call must be resolved exactly once');
    }
    this.resolutions.set(message.tool_call_id, { message, meta });
  }

  finish(): ToolRound {
    const ordered = (this.assistant.tool_calls ?? []).map((call) => {
      const resolution = this.resolutions.get(call.id);
      if (!resolution) throw new Error(`Missing tool result for ${call.id}`);
      return resolution;
    });
    return {
      assistant: this.assistant,
      results: ordered.map((result) => result.message),
      meta: ordered.map((result) => result.meta),
    };
  }

  /** Resolved siblings travel with pending external calls until continuation. */
  resolved(): Message[] {
    return (this.assistant.tool_calls ?? []).flatMap((call) => {
      const result = this.resolutions.get(call.id);
      return result ? [result.message] : [];
    });
  }
}
