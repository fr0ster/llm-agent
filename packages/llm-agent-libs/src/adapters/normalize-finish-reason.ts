import type { LlmFinishReason } from '@mcp-abap-adt/llm-agent';

export function normalizeFinishReason(reason: string): LlmFinishReason {
  switch (reason) {
    case 'tool_use':
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
    case 'length':
      return 'length';
    case 'error':
      return 'error';
    default:
      return 'stop';
  }
}
