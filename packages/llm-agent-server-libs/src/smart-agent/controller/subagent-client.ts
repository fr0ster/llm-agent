import type { ILlm, LlmTool, Message } from '@mcp-abap-adt/llm-agent';
import type { SubagentResult } from './types.js';

export interface ISubagentClient {
  send(messages: Message[], tools?: LlmTool[]): Promise<SubagentResult>;
}

export function makeSubagentClient(llm: ILlm): ISubagentClient {
  return {
    async send(messages, tools) {
      const r = await llm.chat(messages, tools);
      if (!r.ok)
        return {
          kind: 'error',
          error: r.error?.message ?? 'subagent llm error',
        };
      const v = r.value;
      const usage = v.usage ? { usage: v.usage } : {};
      if (v.toolCalls && v.toolCalls.length > 0)
        return { kind: 'tool_call', toolCalls: v.toolCalls, ...usage };
      return { kind: 'content', content: v.content ?? '', ...usage };
    },
  };
}
