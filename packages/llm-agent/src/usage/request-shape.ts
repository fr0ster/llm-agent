import type { UsageRecord } from '../interfaces/usage.js';
export interface ShapeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ReadonlyArray<{
    function: { name: string; arguments: string };
  }>;
}

export type RequestShape = Pick<
  Extract<UsageRecord, { kind: 'llm.call' }>,
  | 'inputMessages'
  | 'systemMessages'
  | 'userMessages'
  | 'assistantMessages'
  | 'toolMessages'
  | 'inputChars'
  | 'systemChars'
  | 'userChars'
  | 'assistantChars'
  | 'toolChars'
  | 'toolDefs'
  | 'toolDefsChars'
>;

/** Measure UTF-16 lengths only, without retaining message or tool content. */
export function requestShape<TTool>(
  messages: readonly ShapeMessage[],
  tools?: readonly TTool[],
): RequestShape {
  const shape = {
    inputMessages: 0,
    systemMessages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolMessages: 0,
    inputChars: 0,
    systemChars: 0,
    userChars: 0,
    assistantChars: 0,
    toolChars: 0,
    toolDefs: 0,
    toolDefsChars: 0,
  };
  for (const message of messages) {
    let chars = message.content?.length ?? 0;
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        chars += call.function.name.length + call.function.arguments.length;
      }
    }
    shape[`${message.role}Messages`] += 1;
    shape[`${message.role}Chars`] += chars;
    shape.inputMessages += 1;
    shape.inputChars += chars;
  }
  shape.toolDefs = tools?.length ?? 0;
  shape.toolDefsChars = tools?.length ? JSON.stringify(tools).length : 0;
  return shape;
}
